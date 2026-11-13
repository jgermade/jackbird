// The covers, each kept once (helpers/cover.ts). The library holds references to them,
// `jackbird-cover:<name>`; the pictures are here, in memory, once each, as bytes (not base64),
// and in each folder's `.meta/covers/<name>`. A picture is drawn through a blob URL made
// the first time it is shown; one only named (by a `.meta/` read at opening) is read from its
// folder then. Before, every track carried its cover as a data URL: twelve copies of an album's
// picture in memory, in `.meta/`, over the desktop app's IPC and in the page, which made opening a
// folder slow, the more so in WebKit. See RECORD/2026-11-03.deck-design-system.WIP.md (2026-11-14).

import type { VFSAdapter } from "@cloudauthn/vfs-sync";
import { $reactive } from "jq79";
import { coverMime, coverName, coverRef, coverToDataUrl, dataUrlToCover, refName } from "../helpers/cover";
import type { MetaSnapshot, RootSource, TrackMetadata } from "../types";

/** Where a folder keeps its covers. */
export const COVERS_DIR = ".meta/covers";

type Kept = { data: Uint8Array; mime: string; url: string | null };

/** The pictures in memory, by name. */
const kept = new Map<string, Kept>();
/** The folders a picture can be read from, by name: those whose `.meta/` names it. */
const folders = new Map<string, VFSAdapter[]>();
/** The pictures being read from a folder, by name. */
const reading = new Map<string, Promise<Kept | null>>();
/** The pictures each folder has in its `.meta/covers/`, as far as this session knows. */
const written = new WeakMap<VFSAdapter, Set<string>>();

/** Bumped when a picture comes in, so whatever draws one asks again. */
export const covers = $reactive({ version: 0 });

const writtenIn = (vfs: VFSAdapter): Set<string> => {
  let names = written.get(vfs);
  if (!names) written.set(vfs, (names = new Set()));
  return names;
};

/** Keeps a picture's bytes under its name; a name already kept is left as it is. */
export function keepCover(name: string, data: Uint8Array): void {
  if (kept.has(name)) return;
  kept.set(name, { data, mime: coverMime(name), url: null });
}

/** A cover as the library holds it: a reference for a data URL (the picture kept here), anything else as it is. */
export function internCover(value: string | null): string | null {
  if (!value?.startsWith("data:")) return value;
  const cover = dataUrlToCover(value);
  if (!cover) return value;
  const name = coverName(cover);
  keepCover(name, cover.data);
  return coverRef(name);
}

/** Tags whose cover is a reference; the same object when it already was. */
export function internMetadata<M extends TrackMetadata | null>(metadata: M): M {
  if (!metadata?.coverDataUrl?.startsWith("data:")) return metadata;
  return { ...metadata, coverDataUrl: internCover(metadata.coverDataUrl) };
}

/** A snapshot whose covers are references, and whether any was not (an older `.meta/`, to write again). */
export function internSnapshot(snapshot: MetaSnapshot): { snapshot: MetaSnapshot; changed: boolean } {
  let changed = false;
  const tracks: MetaSnapshot["tracks"] = {};
  for (const [path, record] of Object.entries(snapshot.tracks)) {
    const metadata = internMetadata(record.metadata);
    if (metadata !== record.metadata) changed = true;
    tracks[path] = metadata === record.metadata ? record : { ...record, metadata };
  }
  return { snapshot: changed ? { ...snapshot, tracks } : snapshot, changed };
}

/** The names a snapshot's tracks refer to. */
export function namesIn(snapshot: MetaSnapshot): Set<string> {
  const names = new Set<string>();
  for (const record of Object.values(snapshot.tracks)) {
    const name = refName(record.metadata.coverDataUrl);
    if (name) names.add(name);
  }
  return names;
}

/**
 * A folder's `.meta/` names these pictures: each is looked for there. Returns those neither in
 * memory nor in its `.meta/covers/` (a folder copied without them, a write that failed): their
 * tracks' tags are to be read again.
 */
export async function coversIn(vfs: VFSAdapter, names: Iterable<string>): Promise<Set<string>> {
  const missing = new Set<string>();
  const there = writtenIn(vfs);
  await Promise.all(
    [...names].map(async (name) => {
      const found = await vfs.stat(`${COVERS_DIR}/${name}`).catch(() => null);
      if (found?.kind === "file") {
        there.add(name);
        const places = folders.get(name) ?? [];
        if (!places.includes(vfs)) folders.set(name, [...places, vfs]);
      } else if (!kept.has(name)) {
        missing.add(name);
      }
    })
  );
  return missing;
}

/** Reads a picture from the first folder that has it; null when none does. */
function readCover(name: string): Promise<Kept | null> {
  const under = reading.get(name);
  if (under) return under;
  const read = (async () => {
    for (const vfs of folders.get(name) ?? []) {
      const data = await vfs.read(`${COVERS_DIR}/${name}`).catch(() => null);
      if (data) {
        keepCover(name, data);
        return kept.get(name) ?? null;
      }
    }
    return null;
  })();
  reading.set(name, read);
  void read.then((found) => {
    reading.delete(name);
    if (found) covers.version += 1;
  });
  return read;
}

/**
 * What an <img> shows for a cover: a blob URL for a reference (null until its picture is read,
 * which this starts), a data URL or any other URL as it is. Reads `covers.version`, so a view
 * calling it draws again once the picture is in.
 */
export function coverSrc(value: string | null | undefined): string | null {
  void covers.version;
  const name = refName(value);
  if (!name) return value ?? null;
  const found = kept.get(name);
  if (!found) {
    void readCover(name);
    return null;
  }
  found.url ??= URL.createObjectURL(new Blob([found.data as Uint8Array<ArrayBuffer>], { type: found.mime }));
  return found.url;
}

/** A cover as a data URL, for what takes a picture whole (a tag to write); null when it cannot be had. */
export async function coverDataUrl(value: string | null): Promise<string | null> {
  const name = refName(value);
  if (!name) return value;
  const found = kept.get(name) ?? (await readCover(name));
  return found ? coverToDataUrl(found) : null;
}

/**
 * A cover as a data URL now, for what cannot wait (a phone's lock screen): null for a picture not
 * in memory yet, which this starts reading for the next time.
 */
export function coverDataUrlNow(value: string | null): string | null {
  const name = refName(value);
  if (!name) return value;
  const found = kept.get(name);
  if (!found) void readCover(name);
  return found ? coverToDataUrl(found) : null;
}

/**
 * Writes into a folder's `.meta/covers/` the pictures its snapshot names that it does not have yet.
 * Returns the names that could not be written (the snapshot then keeps those as data URLs).
 */
export async function writeCovers(vfs: VFSAdapter, snapshot: MetaSnapshot): Promise<Set<string>> {
  const there = writtenIn(vfs);
  const failed = new Set<string>();
  for (const name of namesIn(snapshot)) {
    if (there.has(name)) continue;
    const found = kept.get(name);
    if (!found) continue;
    try {
      await vfs.write(`${COVERS_DIR}/${name}`, found.data);
      there.add(name);
      const places = folders.get(name) ?? [];
      if (!places.includes(vfs)) folders.set(name, [...places, vfs]);
    } catch {
      failed.add(name);
    }
  }
  return failed;
}

/** A snapshot whose references to `names` are data URLs again (pictures its folder does not have). */
export async function withDataUrls(snapshot: MetaSnapshot, names: Set<string>): Promise<MetaSnapshot> {
  if (names.size === 0) return snapshot;
  const urls = new Map<string, string | null>();
  for (const name of names) urls.set(name, await coverDataUrl(coverRef(name)));
  const tracks: MetaSnapshot["tracks"] = {};
  for (const [path, record] of Object.entries(snapshot.tracks)) {
    const name = refName(record.metadata.coverDataUrl);
    tracks[path] = name && urls.has(name) ? { ...record, metadata: { ...record.metadata, coverDataUrl: urls.get(name) ?? null } } : record;
  }
  return { ...snapshot, tracks };
}

/**
 * A root's source whose tags come with references for covers, and which writes a cover given by
 * reference as the picture itself when it is not the track's own (the engines keep a cover only
 * when it is the same as before, and take a new one as a data URL).
 */
export function withCovers(source: RootSource): RootSource {
  return {
    ...source,
    async inspect(path, known) {
      const found = await source.inspect(path, known);
      return { ...found, metadata: internMetadata(found.metadata) };
    },
    async save(path, previous, metadata, scope, expected) {
      const cover = metadata.coverDataUrl !== previous.coverDataUrl ? await coverDataUrl(metadata.coverDataUrl) : metadata.coverDataUrl;
      const written = await source.save(path, previous, { ...metadata, coverDataUrl: cover }, scope, expected);
      return { ...written, metadata: internMetadata(written.metadata) };
    }
  };
}
