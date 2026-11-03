import type { MetaSnapshot } from "../types.ts";

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
