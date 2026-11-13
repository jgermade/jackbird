/**
 * jackbird's tags and checksums, for the web app: one interface over the tag
 * engine (`crates/tags`), which runs as WebAssembly and is loaded only when a
 * file has to be read, written or hashed, never for a library that reopens
 * from `.meta/` (E2-D4 and E2-D5 of
 * RECORD/2026-08-11.musikmatch-rust-migration.WIP.md, 2026-11-07 20:16). The
 * desktop app (E4) gives the same interface over Tauri commands.
 */
import { editFor } from "../../helpers/cover.ts";
import { internCoverBytes } from "../covers.ts";
import { emptyMetadata } from "../../helpers/metadata.ts";
import type { TrackMetadata } from "../../types.ts";
import type { WireLayout } from "../../helpers/tagwire.ts";
import { layoutOf, readOf, writeOf } from "./engine.ts";
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

/** The layouts found, by the bytes they were found in: the scan asks for checksums and tags of one file. */
const layouts = new WeakMap<Uint8Array, WireLayout>();

function layoutFor(one: Engine, bytes: Uint8Array): WireLayout {
  let layout = layouts.get(bytes);
  if (!layout) {
    layout = layoutOf(one, bytes);
    layouts.set(bytes, layout);
  }
  return layout;
}

/** A file's tags as the library holds them. A file the engine cannot read reads as untagged. */
export async function readTags(bytes: Uint8Array): Promise<TrackMetadata> {
  const one = await engine();
  let tags;
  try {
    const layout = layoutFor(one, bytes);
    tags = layout.format ? readOf(one, bytes, layout) : null;
  } catch (error) {
    if (!(error instanceof TagError) || error.code === "engine-failed") {
      throw error;
    }
    tags = null;
  }
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
    discNumber: tags.fields.disc,
    albumArtist: tags.fields.albumArtist,
    compilation: tags.fields.compilation,
    // Kept once, by reference (lib/covers.ts): never made into a data URL to be read back.
    coverDataUrl: tags.cover ? internCoverBytes(tags.cover) : null
  };
}

/**
 * The file with `metadata` written over the tags it had (`previous`, as the
 * library holds them), checked by the engine's safeguards and, before it is
 * given back, end to end: its audio region hashes as the source's did. Or a
 * TagError saying why not; nothing is written then.
 */
export async function writeTags(bytes: Uint8Array, previous: TrackMetadata, metadata: TrackMetadata): Promise<Uint8Array> {
  const one = await engine();
  const layout = layoutFor(one, bytes);
  if (!layout.format) {
    throw new TagError("not-supported", "not an MP3 or FLAC file");
  }
  const out = writeOf(one, bytes, layout, editFor(previous, metadata));
  if (out === bytes) {
    return out;
  }
  const after = layoutFor(one, out);
  const [before, now] = await Promise.all([
    sha1Hex(bytes.subarray(layout.audio.start, layout.audio.end)),
    sha1Hex(out.subarray(after.audio.start, after.audio.end))
  ]);
  if (before !== now) {
    throw new TagError("refused-audio", "the saved file's audio would differ from the source's");
  }
  return out;
}

async function sha1Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-1", bytes as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

/** The SHA-1 of the whole file and of its audio region, the engine's (E-D5: the definitions `.meta/` already holds). */
export async function checksums(bytes: Uint8Array): Promise<{ fullChecksum: string; audioChecksum: string }> {
  const { start, end } = layoutFor(await engine(), bytes).audio;
  const [fullChecksum, audioChecksum] = await Promise.all([sha1Hex(bytes), sha1Hex(bytes.subarray(start, end))]);
  return { fullChecksum, audioChecksum };
}
