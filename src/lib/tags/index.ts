/**
 * jackbird's tags and checksums, for the web app: one interface over the tag
 * engine (`crates/tags`), which runs as WebAssembly and is loaded only when a
 * file has to be read, written or hashed, never for a library that reopens
 * from `.meta/` (E2-D4 and E2-D5 of
 * RECORD/2026-08-11.musikmatch-rust-migration.WIP.md, 2026-11-07 20:16). The
 * desktop app (E4) gives the same interface over Tauri commands.
 */
import { coverToDataUrl, editFor } from "../../helpers/cover.ts";
import { emptyMetadata } from "../../helpers/metadata.ts";
import type { TrackMetadata } from "../../types.ts";
import { TagError } from "./error.ts";
import type { Engine } from "./wasm.ts";

export { TagError };

let loading: Promise<Engine> | null = null;

/** The engine, loaded on the first call; loaded again if it failed to load or broke. */
async function engine(): Promise<Engine> {
  if (loading) {
    const current = await loading.catch(() => null);
    if (current && !current.broken) {
      return current;
    }
  }
  loading = import("./wasm.ts").then((module) => module.load());
  return loading;
}

/** A file's tags as the library holds them. A file the engine cannot read reads as untagged. */
export async function readTags(bytes: Uint8Array): Promise<TrackMetadata> {
  const tags = await engine().then((one) => one.read(bytes)).catch((error: unknown) => {
    if (error instanceof TagError && error.code !== "engine-failed") {
      return null;
    }
    throw error;
  });
  if (!tags) {
    return emptyMetadata();
  }
  return {
    title: tags.fields.title,
    artist: tags.fields.artist,
    album: tags.fields.album,
    year: tags.fields.year,
    genre: tags.fields.genre,
    trackNumber: tags.fields.track,
    coverDataUrl: tags.cover ? coverToDataUrl(tags.cover) : null
  };
}

/**
 * The file with `metadata` written over the tags it had (`previous`, as the
 * library holds them), checked by the engine's safeguards; or a TagError
 * saying why not.
 */
export async function writeTags(bytes: Uint8Array, previous: TrackMetadata, metadata: TrackMetadata): Promise<Uint8Array> {
  return (await engine()).write(bytes, editFor(previous, metadata));
}

async function sha1Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-1", bytes as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

/** The SHA-1 of the whole file and of its audio region, the engine's (E-D5: the definitions `.meta/` already holds). */
export async function checksums(bytes: Uint8Array): Promise<{ fullChecksum: string; audioChecksum: string }> {
  const { start, end } = (await engine()).region(bytes);
  const [fullChecksum, audioChecksum] = await Promise.all([sha1Hex(bytes), sha1Hex(bytes.subarray(start, end))]);
  return { fullChecksum, audioChecksum };
}
