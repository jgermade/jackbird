import type { Mp3Track } from "../types.ts";

/**
 * The disc a track sits on, from a `CD2`, `disc 2` or `Disc_2` folder in its
 * path; disc 1 when there is none.
 */
export function inferDiscLabel(track: Mp3Track): string {
  const byPath = track.relativePath.match(/(?:^|\/)(?:cd|disc)[ _-]?(\d+)(?:\/|$)/i);
  return `Disco ${byPath?.[1] ?? "1"}`;
}

/** The first number in a track number (`"03/12"` is 3); tracks without one sort last. */
export function trackNumberOrder(track: Mp3Track): number {
  const match = track.metadata.trackNumber.match(/\d+/);
  return match ? Number(match[0]) : Number.POSITIVE_INFINITY;
}

/** The album a track is grouped under: its tag, or the first folder of its path. */
function albumKey(track: Mp3Track): string {
  return track.metadata.album || track.relativePath.split("/")[0];
}

/** Tracks in playing order: by album, then disc, then track number, then file name. */
export function orderDetailPlaylist(tracks: Mp3Track[]): Mp3Track[] {
  return [...tracks].sort(
    (left, right) =>
      albumKey(left).localeCompare(albumKey(right), "es") ||
      inferDiscLabel(left).localeCompare(inferDiscLabel(right), "es", { numeric: true }) ||
      trackNumberOrder(left) - trackNumberOrder(right) ||
      left.name.localeCompare(right.name, "es")
  );
}

/** Every folder that holds a track, at any depth, each once: `a`, `a/b`, `a/b/c`. */
export function collectFolderPaths(tracks: Mp3Track[]): string[] {
  const paths = new Set<string>();
  for (const track of tracks) {
    let current = "";
    for (const folder of track.relativePath.split("/").slice(0, -1)) {
      current = current ? `${current}/${folder}` : folder;
      paths.add(current);
    }
  }
  return [...paths];
}
