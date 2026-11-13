import type { MetaRecord, MetaSnapshot, Track, TrackMetadata } from "../types.ts";

/** A snapshot with no tracks. */
export function emptySnapshot(): MetaSnapshot {
  return { version: 1, tracks: {} };
}

/**
 * Reads `.meta/mp3-manager.json` from its text. Anything that is not a
 * version-1 snapshot with tracks, unreadable JSON included, reads as empty:
 * the library is then rebuilt from the files.
 */
export function parseMetaSnapshot(raw: string): MetaSnapshot {
  const text = raw.trim();
  if (!text) {
    return emptySnapshot();
  }
  try {
    const parsed = JSON.parse(text) as Partial<MetaSnapshot> | null;
    return parsed?.version === 1 && parsed.tracks ? (parsed as MetaSnapshot) : emptySnapshot();
  } catch {
    return emptySnapshot();
  }
}

/** The snapshot as the file stores it: JSON, indented by two spaces. */
export function serializeMetaSnapshot(snapshot: MetaSnapshot): string {
  return JSON.stringify(snapshot, null, 2);
}

/** The checksum the library holds for a track: the full one, else the legacy one. */
export function checksumOf(track: Track): string {
  return track.fullChecksum || track.checksum;
}

/** What the background verifier found in a track's file. */
export type Verification = {
  fullChecksum: string;
  audioChecksum: string;
  /**
   * The file as it is now, when it no longer has the checksum the library
   * holds: something outside the app changed it, so its tags are read again.
   */
  file?: { metadata: TrackMetadata; size: number; lastModified?: number };
};

type WithSnapshot = { tracks: Track[]; metaSnapshot: MetaSnapshot };

/**
 * A root after the verifier checked one track, as new objects (nothing given
 * is changed). The track and its `.meta` record take the checksums and the
 * time, with the track's current tags, size and date, or the file's when it
 * changed (`found.file`). The record keeps its `updatedAt` unless the file
 * changed.
 *
 * `null` when the result no longer applies: the track is gone, or its
 * checksum is not `readFrom`, the one it had when its file was read. Then
 * something else (a save, a rescan) wrote it and recorded it since, and its
 * record must not be overwritten with what was read before.
 */
export function applyVerification<Root extends WithSnapshot>(
  root: Root,
  trackId: string,
  readFrom: string,
  found: Verification,
  nowIso: string
): Root | null {
  const track = root.tracks.find((item) => item.id === trackId);
  if (!track || checksumOf(track) !== readFrom) {
    return null;
  }

  const { fullChecksum, audioChecksum, file } = found;
  const facts = file ?? { metadata: track.metadata, size: track.size, lastModified: track.lastModified };
  const verified: Track = { ...track, ...facts, checksum: fullChecksum, fullChecksum, audioChecksum, lastVerifiedAt: nowIso };
  const previous = root.metaSnapshot.tracks[track.relativePath];

  return {
    ...root,
    tracks: root.tracks.map((item) => (item === track ? verified : item)),
    metaSnapshot: {
      ...root.metaSnapshot,
      tracks: {
        ...root.metaSnapshot.tracks,
        [track.relativePath]: {
          checksum: fullChecksum,
          fullChecksum,
          audioChecksum,
          size: facts.size,
          lastModified: facts.lastModified,
          lastVerifiedAt: nowIso,
          metadata: facts.metadata,
          updatedAt: file || !previous ? nowIso : previous.updatedAt
        }
      }
    }
  };
}

/** One file's checksums worked out in bulk (the desktop app's), with its size and date then. */
export type Sums = { trackId: string; readFrom: string; fullChecksum: string; audioChecksum: string; size: number; lastModified: number };

/**
 * A root after a batch of checksums worked out in bulk, as new objects, in one pass (a track at a
 * time, as applyVerification, was quadratic over a folder). Each sets its track's checksums and
 * verification time, and its record, the tags kept. Left out: a track gone, or whose checksum is
 * no longer the one it was read from (a save since), or whose file had another size or date when
 * it was read than the library holds (it changed since its tags were read: the verifier reads it
 * again whole). The root itself when none applies; `applied` lists those that did.
 */
export function applySums<Root extends WithSnapshot>(root: Root, sums: readonly Sums[], nowIso: string): { root: Root; applied: string[] } {
  const byId = new Map(root.tracks.map((item) => [item.id, item]));
  const changed = new Map<string, Track>();
  const records: Record<string, MetaRecord> = {};
  for (const sum of sums) {
    const track = byId.get(sum.trackId);
    if (!track || checksumOf(track) !== sum.readFrom || track.size !== sum.size || track.lastModified !== sum.lastModified) continue;
    const { fullChecksum, audioChecksum } = sum;
    changed.set(track.id, { ...track, checksum: fullChecksum, fullChecksum, audioChecksum, lastVerifiedAt: nowIso });
    const previous = root.metaSnapshot.tracks[track.relativePath];
    records[track.relativePath] = {
      checksum: fullChecksum,
      fullChecksum,
      audioChecksum,
      size: track.size,
      lastModified: track.lastModified,
      lastVerifiedAt: nowIso,
      metadata: track.metadata,
      updatedAt: previous?.updatedAt ?? nowIso
    };
  }
  if (changed.size === 0) return { root, applied: [] };
  return {
    root: {
      ...root,
      tracks: root.tracks.map((item) => changed.get(item.id) ?? item),
      metaSnapshot: { ...root.metaSnapshot, tracks: { ...root.metaSnapshot.tracks, ...records } }
    },
    applied: [...changed.keys()]
  };
}

/** What the initial scan read from one file. */
export type ScanResult = {
  trackId: string;
  /** The checksum its track had in the library when the file was read. */
  readFrom: string;
  /** The file's `.meta` record, as read: checksums, size, date, tags and times. */
  record: MetaRecord;
};

/**
 * A root after the initial scan read a batch of files, as new objects
 * (nothing given is changed). Each result sets its track's checksums, size,
 * date, tags and verification time, and its `.meta` record. A result whose
 * track is gone, or no longer has the checksum it was read from, is left out:
 * something else (a save) wrote and recorded that track since, and its
 * record stands; but a file new to the library, among `adding`, becomes a
 * track at the end of the list. The root itself when no result applies.
 */
export function applyScanResults<Root extends WithSnapshot>(root: Root, results: readonly ScanResult[], adding: ReadonlySet<string> = new Set()): Root {
  const byId = new Map(root.tracks.map((item) => [item.id, item]));
  const changed = new Map<string, Track>();
  const added: string[] = [];
  const records: Record<string, MetaRecord> = {};
  for (const { trackId, readFrom, record } of results) {
    let track = changed.get(trackId) ?? byId.get(trackId);
    // A file new to the library, shown with its tags (the desktop app's scan adds no empty rows first).
    if (!track && adding.has(trackId) && readFrom === "") {
      track = { id: trackId, name: trackId.split("/").at(-1) ?? trackId, relativePath: trackId, size: record.size ?? 0, checksum: "", metadata: record.metadata };
      added.push(trackId);
    }
    if (!track || checksumOf(track) !== readFrom) {
      continue;
    }
    changed.set(trackId, {
      ...track,
      checksum: record.checksum,
      fullChecksum: record.fullChecksum,
      audioChecksum: record.audioChecksum,
      size: record.size ?? track.size,
      lastModified: record.lastModified,
      lastVerifiedAt: record.lastVerifiedAt,
      metadata: record.metadata
    });
    records[track.relativePath] = record;
  }
  if (changed.size === 0) {
    return root;
  }
  const tracks = root.tracks.map((item) => changed.get(item.id) ?? item);
  for (const trackId of added) {
    const track = changed.get(trackId);
    if (track) tracks.push(track);
  }
  return {
    ...root,
    tracks,
    metaSnapshot: { ...root.metaSnapshot, tracks: { ...root.metaSnapshot.tracks, ...records } }
  };
}

/** A snapshot without the records of `paths` (files gone from disk); the snapshot itself when it has none of them. */
export function omitRecords(snapshot: MetaSnapshot, paths: readonly string[]): MetaSnapshot {
  if (!paths.some((path) => path in snapshot.tracks)) {
    return snapshot;
  }
  const gone = new Set(paths);
  return { ...snapshot, tracks: Object.fromEntries(Object.entries(snapshot.tracks).filter(([path]) => !gone.has(path))) };
}
