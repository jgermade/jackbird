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
 * record stands. The root itself when no result applies.
 */
export function applyScanResults<Root extends WithSnapshot>(root: Root, results: readonly ScanResult[]): Root {
  const byId = new Map(root.tracks.map((item) => [item.id, item]));
  const changed = new Map<string, Track>();
  const records: Record<string, MetaRecord> = {};
  for (const { trackId, readFrom, record } of results) {
    const track = changed.get(trackId) ?? byId.get(trackId);
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
  return {
    ...root,
    tracks: root.tracks.map((item) => changed.get(item.id) ?? item),
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
