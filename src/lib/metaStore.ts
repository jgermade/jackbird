/**
 * `.meta` v2: one sidecar per track plus a content-addressed image store.
 *
 * ```
 * .meta/
 * ├── library.json                  # schema gate; written last, so it commits the layout
 * ├── tracks/<track_id>.json        # one record per track, named by identity not by path
 * ├── images/<sha256>.front.<ext>   # canonical artwork, deduplicated by content
 * └── mp3-manager.json              # v1, read only, kept so nothing is destroyed
 * ```
 *
 * Three properties this buys, in the order they matter:
 *
 * 1. **One writer per file.** Editing one track rewrites one small JSON, not the whole
 *    library — the O(n) rewrite is gone.
 * 2. **A conflict costs one song.** Two peers editing different tracks never touch the same
 *    file, so a bad merge is a conflict copy of one sidecar.
 * 3. **Renaming is an edit.** The sidecar is named by `track_id`, which never moves, so
 *    renaming the audio is a field change in a file that does not change name.
 *
 * Sidecars are named by `track_id` (a uuid) rather than by `audio_sha256` as the first sketch
 * had it: both give an immutable name, but a uuid lets the migration be a pure metadata
 * transformation — the v1 hashes are SHA-1, so a content-named layout would have to re-read
 * every audio file before the first render, which is exactly what the snapshot-first startup
 * exists to avoid. `audio_sha256` is still a field, filled in by the background verifier.
 */
import type { VFSAdapter } from "@cloudauthn/vfs-sync";
import type { TrackMetadata } from "../types";
import { sha256Hex } from "./id3";

export const META_DIR = ".meta";
export const LIBRARY_FILE = `${META_DIR}/library.json`;
export const LEGACY_FILE = `${META_DIR}/mp3-manager.json`;
export const TRACKS_DIR = `${META_DIR}/tracks`;
export const IMAGES_DIR = `${META_DIR}/images`;
export const SCHEMA_VERSION = 2;

/** The in-memory shape the UI works with: one record per audio path. */
export type MetaRecord = {
  trackId: string;
  checksum: string;
  fullChecksum?: string;
  audioChecksum?: string;
  size?: number;
  lastModified?: number;
  lastVerifiedAt?: string;
  metadata: TrackMetadata;
  updatedAt: string;
};

export type MetaSnapshot = {
  version: typeof SCHEMA_VERSION;
  tracks: Record<string, MetaRecord>;
};

/** A file whose `schema` this build does not know. Nothing may be written over it. */
export class UnsupportedMetaVersionError extends Error {
  constructor(file: string, found: unknown) {
    super(
      `${file} declara una version de formato desconocida (${String(found)}). ` +
        "No se ha escrito nada para no perder la biblioteca."
    );
    this.name = "UnsupportedMetaVersionError";
  }
}

/**
 * A control file that exists but cannot be read.
 *
 * Distinct from "absent" on purpose: treating an unreadable `library.json` as a fresh folder
 * would render an empty library while every sidecar sat intact on disk, and the next save
 * would write new ones next to the old. Refusing is the only outcome that cannot lose data.
 */
export class MetaFileCorruptError extends Error {
  constructor(file: string) {
    super(`${file} existe pero no se puede leer como JSON. No se ha escrito nada.`);
    this.name = "MetaFileCorruptError";
  }
}

type CoverRef = { hash: string; role: string; mime: string };

type LibraryFile = { schema: number; created_at: string };

type TrackFile = {
  track_id: string;
  path: string;
  audio_sha256: string | null;
  audio_sha1: string | null;
  full_sha1: string | null;
  size: number | null;
  mtime: number | null;
  verified_at: string | null;
  tags: Omit<TrackMetadata, "coverDataUrl">;
  images: CoverRef[];
  mbid_recording: null;
  mbid_release: null;
  acoustid: null;
  rev_id: null;
  updated_at: string;
};

type LegacySnapshot = {
  version: 1;
  tracks: Record<string, Partial<MetaRecord> & { metadata?: unknown }>;
};

const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/bmp": "bmp"
};

/** Write-through caches, per adapter: what this session already knows is on disk. */
const imageCache = new WeakMap<VFSAdapter, Set<string>>();
const libraryKnown = new WeakMap<VFSAdapter, boolean>();

export function emptySnapshot(): MetaSnapshot {
  return { version: SCHEMA_VERSION, tracks: {} };
}

export function newTrackId(): string {
  return crypto.randomUUID();
}

/** The predicate the walk takes: `.meta` is the metadata plane, never track content. */
export function isMetaPath(path: string): boolean {
  return path === META_DIR || path.startsWith(`${META_DIR}/`);
}

// ------------------------------------------------------------------ loading

export async function loadMetaSnapshot(vfs: VFSAdapter): Promise<MetaSnapshot> {
  const header = await readJson(vfs, LIBRARY_FILE);
  if (header.kind === "corrupt") throw new MetaFileCorruptError(LIBRARY_FILE);
  if (header.kind === "parsed") {
    const schema = isRecord(header.value) ? header.value.schema : undefined;
    if (schema !== SCHEMA_VERSION) throw new UnsupportedMetaVersionError(LIBRARY_FILE, schema);
    return readTracks(vfs);
  }

  const legacy = await readJson(vfs, LEGACY_FILE);
  if (legacy.kind === "absent") return emptySnapshot(); // a fresh folder, not an error
  if (legacy.kind === "corrupt") throw new MetaFileCorruptError(LEGACY_FILE);

  if (!isRecord(legacy.value) || legacy.value.version !== 1) {
    throw new UnsupportedMetaVersionError(
      LEGACY_FILE,
      isRecord(legacy.value) ? legacy.value.version : undefined
    );
  }

  const snapshot = await migrateLegacy(vfs, legacy.value as LegacySnapshot);
  // Commit marker last: a migration interrupted before this line leaves no v2 header, so the
  // next load retries from scratch instead of trusting a half-written layout.
  await writeLibraryHeader(vfs);
  return snapshot;
}

async function readTracks(vfs: VFSAdapter): Promise<MetaSnapshot> {
  const snapshot = emptySnapshot();
  const entries = await vfs.list(TRACKS_DIR);
  const files = entries.filter((entry) => entry.kind === "file" && entry.path.endsWith(".json"));
  const known = new Set<string>();

  const parsedTracks = await mapLimit(files, 6, async (entry) => {
    const parsed = await readJson(vfs, entry.path);
    // One unreadable sidecar must not cost the whole library: skip it, and the walk will
    // treat its audio as a new file. The stray file is left for GC rather than deleted.
    if (parsed.kind !== "parsed" || !isRecord(parsed.value)) return null;
    const name = entry.name.replace(/\.json$/, "");
    return fromTrackFile(parsed.value as unknown as TrackFile, name);
  });

  const loaded = parsedTracks.filter(
    (track): track is NonNullable<typeof track> => track !== null
  );

  const covers = new Map<string, string | null>();
  await mapLimit(loaded, 4, async (track) => {
    for (const image of track.images) known.add(imageFileName(image));
    track.record.metadata.coverDataUrl = await readCover(vfs, track.images[0], covers);
    snapshot.tracks[track.path] = track.record;
  });

  imageCache.set(vfs, known);
  return snapshot;
}

// ------------------------------------------------------------------- saving

/**
 * Writes only the sidecars for `paths`. Callers batch rather than snapshot: this is the
 * method that replaced "serialise the whole library every ten verified files".
 */
export async function saveMetaRecords(
  vfs: VFSAdapter,
  snapshot: MetaSnapshot,
  paths: string[]
): Promise<void> {
  const unique = [...new Set(paths)].filter((path) => snapshot.tracks[path]);
  if (unique.length === 0) return;

  await ensureLibraryHeader(vfs);

  await mapLimit(unique, 6, async (path) => {
    const record = snapshot.tracks[path];
    // A record without an id would be written to a name minted per call, orphaning the
    // previous sidecar on every save. Mint once, then keep it.
    if (!record.trackId) record.trackId = newTrackId();
    const images = await ensureCover(vfs, record);
    await writeTrackFile(vfs, path, record, images);
  });
}

export async function deleteMetaRecords(
  vfs: VFSAdapter,
  snapshot: MetaSnapshot,
  paths: string[]
): Promise<void> {
  const records = paths.map((path) => snapshot.tracks[path]).filter(Boolean);
  if (records.length === 0) return;

  await mapLimit(records, 6, async (record) => {
    try {
      await vfs.delete(`${TRACKS_DIR}/${record.trackId}.json`);
    } catch {
      // Already gone: the sidecar follows the audio, it does not outlive it.
    }
  });
}

async function writeLibraryHeader(vfs: VFSAdapter): Promise<void> {
  const file: LibraryFile = { schema: SCHEMA_VERSION, created_at: new Date().toISOString() };
  await writeJson(vfs, LIBRARY_FILE, file);
  libraryKnown.set(vfs, true);
}

async function ensureLibraryHeader(vfs: VFSAdapter): Promise<void> {
  if (libraryKnown.get(vfs)) return;
  const existing = await vfs.stat(LIBRARY_FILE);
  if (existing) {
    libraryKnown.set(vfs, true);
    return;
  }
  await writeLibraryHeader(vfs);
}

async function writeTrackFile(
  vfs: VFSAdapter,
  path: string,
  record: MetaRecord,
  images: CoverRef[]
): Promise<void> {
  const tags: Omit<TrackMetadata, "coverDataUrl"> = {
    title: record.metadata.title,
    artist: record.metadata.artist,
    album: record.metadata.album,
    year: record.metadata.year,
    genre: record.metadata.genre,
    trackNumber: record.metadata.trackNumber
  };
  const file: TrackFile = {
    track_id: record.trackId,
    path,
    audio_sha256: null,
    audio_sha1: record.audioChecksum ?? null,
    full_sha1: record.fullChecksum ?? record.checksum ?? null,
    size: record.size ?? null,
    mtime: record.lastModified ?? null,
    verified_at: record.lastVerifiedAt ?? null,
    tags,
    images,
    mbid_recording: null,
    mbid_release: null,
    acoustid: null,
    rev_id: null,
    updated_at: record.updatedAt
  };

  await writeJson(vfs, `${TRACKS_DIR}/${record.trackId}.json`, file);
}

/**
 * Puts the record's cover in the image store, if it is not already there. The file name is
 * the content hash, so the write is idempotent and identical covers across an album collapse
 * to one file.
 */
async function ensureCover(vfs: VFSAdapter, record: MetaRecord): Promise<CoverRef[]> {
  const cover = parseDataUrl(record.metadata.coverDataUrl);
  if (!cover) return [];

  const hash = await sha256Hex(cover.bytes);
  const ref: CoverRef = { hash, role: "front", mime: cover.mime };
  const name = imageFileName(ref);

  let known = imageCache.get(vfs);
  if (!known) {
    known = new Set();
    imageCache.set(vfs, known);
  }

  if (!known.has(name)) {
    await vfs.write(`${IMAGES_DIR}/${name}`, cover.bytes);
    known.add(name);
  }

  return [ref];
}

// ---------------------------------------------------------------- migration

async function migrateLegacy(vfs: VFSAdapter, legacy: LegacySnapshot): Promise<MetaSnapshot> {
  const snapshot = emptySnapshot();
  const imagesByPath = new Map<string, CoverRef[]>();
  const imageWrites = new Map<string, { bytes: Uint8Array }>();
  const known = new Set<string>();

  for (const [path, old] of Object.entries(legacy.tracks ?? {})) {
    if (!isRecord(old)) continue;

    const metadata = normalizeMetadata(old.metadata);
    const cover = parseDataUrl(metadata.coverDataUrl);
    const images: CoverRef[] = [];

    if (cover) {
      const hash = await sha256Hex(cover.bytes);
      const ref: CoverRef = { hash, role: "front", mime: cover.mime };
      const name = imageFileName(ref);
      images.push(ref);
      imageWrites.set(name, { bytes: cover.bytes });
      known.add(name);
    }

    imagesByPath.set(path, images);
    snapshot.tracks[path] = {
      trackId: newTrackId(),
      checksum: typeof old.checksum === "string" ? old.checksum : "",
      fullChecksum: typeof old.fullChecksum === "string" ? old.fullChecksum : undefined,
      audioChecksum: typeof old.audioChecksum === "string" ? old.audioChecksum : undefined,
      size: typeof old.size === "number" ? old.size : undefined,
      lastModified: typeof old.lastModified === "number" ? old.lastModified : undefined,
      lastVerifiedAt: typeof old.lastVerifiedAt === "string" ? old.lastVerifiedAt : undefined,
      metadata: { ...metadata, coverDataUrl: metadata.coverDataUrl },
      updatedAt: typeof old.updatedAt === "string" ? old.updatedAt : new Date().toISOString()
    };
  }

  // Images first: a sidecar must never reference a file that is not there yet.
  await mapLimit([...imageWrites], 4, ([name, data]) =>
    vfs.write(`${IMAGES_DIR}/${name}`, data.bytes)
  );

  await mapLimit(Object.entries(snapshot.tracks), 6, ([path, record]) =>
    writeTrackFile(vfs, path, record, imagesByPath.get(path) ?? [])
  );

  imageCache.set(vfs, known);
  return snapshot;
}

// ------------------------------------------------------------------ helpers

function fromTrackFile(
  file: TrackFile,
  fallbackId: string
): { path: string; record: MetaRecord; images: CoverRef[] } | null {
  if (typeof file.path !== "string" || file.path.length === 0) return null;

  const images = Array.isArray(file.images) ? file.images.filter(isCoverRef) : [];

  return {
    path: file.path,
    images,
    record: {
      trackId: typeof file.track_id === "string" ? file.track_id : fallbackId,
      checksum: file.full_sha1 ?? "",
      fullChecksum: file.full_sha1 ?? undefined,
      audioChecksum: file.audio_sha1 ?? undefined,
      size: typeof file.size === "number" ? file.size : undefined,
      lastModified: typeof file.mtime === "number" ? file.mtime : undefined,
      lastVerifiedAt: file.verified_at ?? undefined,
      metadata: { ...normalizeMetadata(file.tags), coverDataUrl: null },
      updatedAt: typeof file.updated_at === "string" ? file.updated_at : new Date().toISOString()
    }
  };
}

function normalizeMetadata(raw: unknown): TrackMetadata {
  const source = isRecord(raw) ? raw : {};
  const text = (value: unknown): string => (typeof value === "string" ? value : "");
  return {
    title: text(source.title),
    artist: text(source.artist),
    album: text(source.album),
    year: text(source.year),
    genre: text(source.genre),
    trackNumber: text(source.trackNumber),
    coverDataUrl: typeof source.coverDataUrl === "string" ? source.coverDataUrl : null
  };
}

function isCoverRef(value: unknown): value is CoverRef {
  return (
    isRecord(value) &&
    typeof value.hash === "string" &&
    typeof value.role === "string" &&
    typeof value.mime === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function imageFileName(ref: CoverRef): string {
  const ext = EXT_BY_MIME[ref.mime.toLowerCase()] ?? "bin";
  return `${ref.hash}.${ref.role}.${ext}`;
}

function parseDataUrl(url: string | null): { mime: string; bytes: Uint8Array } | null {
  if (!url || !url.startsWith("data:")) return null;
  const comma = url.indexOf(",");
  if (comma === -1) return null;

  const header = url.slice(5, comma);
  const payload = url.slice(comma + 1);
  if (!header.includes("base64")) return null;

  const mime = header.split(";")[0] || "application/octet-stream";
  try {
    const binary = atob(payload);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return { mime, bytes };
  } catch {
    return null;
  }
}

function toDataUrl(mime: string, bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return `data:${mime};base64,${btoa(binary)}`;
}

async function readCover(
  vfs: VFSAdapter,
  ref: CoverRef | undefined,
  cache: Map<string, string | null>
): Promise<string | null> {
  if (!ref) return null;

  const name = imageFileName(ref);
  if (cache.has(name)) return cache.get(name) ?? null;

  try {
    const bytes = await vfs.read(`${IMAGES_DIR}/${name}`);
    const url = toDataUrl(ref.mime, bytes);
    cache.set(name, url);
    return url;
  } catch {
    cache.set(name, null);
    return null;
  }
}

type JsonRead = { kind: "absent" } | { kind: "parsed"; value: unknown } | { kind: "corrupt" };

async function readJson(vfs: VFSAdapter, path: string): Promise<JsonRead> {
  const stat = await vfs.stat(path);
  if (!stat) return { kind: "absent" };

  try {
    const raw = new TextDecoder().decode(await vfs.read(path)).trim();
    if (!raw) return { kind: "corrupt" };
    return { kind: "parsed", value: JSON.parse(raw) };
  } catch {
    return { kind: "corrupt" };
  }
}

async function writeJson(vfs: VFSAdapter, path: string, value: unknown): Promise<void> {
  const encoded = new TextEncoder().encode(JSON.stringify(value, null, 2));
  await vfs.write(path, encoded);
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}
