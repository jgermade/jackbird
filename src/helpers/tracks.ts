import type { Track } from "../types.ts";

/**
 * The disc a track sits on, from a `CD2`, `disc 2` or `Disc_2` folder in its
 * path; disc 1 when there is none. A number, not a label: the view words it.
 */
export function inferDiscNumber(track: Track): number {
  const byPath = track.relativePath.match(/(?:^|\/)(?:cd|disc)[ _-]?(\d+)(?:\/|$)/i);
  return byPath ? Number(byPath[1]) : 1;
}

/** The first number in a track number (`"03/12"` is 3); tracks without one sort last. */
export function trackNumberOrder(track: Track): number {
  const match = track.metadata.trackNumber.match(/\d+/);
  return match ? Number(match[0]) : Number.POSITIVE_INFINITY;
}

/** The album a track is grouped under: its tag, or the first folder of its path. */
function albumKey(track: Track): string {
  return track.metadata.album || track.relativePath.split("/")[0];
}

/** Tracks in playing order: by album, then disc, then track number, then file name. */
export function orderDetailPlaylist(tracks: Track[]): Track[] {
  return [...tracks].sort(
    (left, right) =>
      albumKey(left).localeCompare(albumKey(right), "es") ||
      inferDiscNumber(left) - inferDiscNumber(right) ||
      trackNumberOrder(left) - trackNumberOrder(right) ||
      left.name.localeCompare(right.name, "es")
  );
}

/** Every folder that holds a track, at any depth, each once: `a`, `a/b`, `a/b/c`. */
export function collectFolderPaths(tracks: Track[]): string[] {
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

/** How long a verification stays fresh: a day. */
export const VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * The tracks the background verifier should check, in the order it should
 * check them: those with no audio checksum first, then by oldest
 * verification (never verified counts as oldest). A track with both an audio
 * checksum and a verification younger than `VERIFICATION_TTL_MS` at `now` is
 * left out.
 */
export function tracksToVerify(tracks: readonly Track[], now: number): Track[] {
  const verifiedAt = (track: Track): number => (track.lastVerifiedAt ? new Date(track.lastVerifiedAt).getTime() : 0);
  return tracks
    .filter((track) => !track.audioChecksum || !track.lastVerifiedAt || now - verifiedAt(track) > VERIFICATION_TTL_MS)
    .sort((a, b) => Number(!!a.audioChecksum) - Number(!!b.audioChecksum) || verifiedAt(a) - verifiedAt(b));
}
