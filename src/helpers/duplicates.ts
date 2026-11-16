/**
 * Duplicates in a root (views/duplicates-dialog.html): exact copies, the same audio (`audioChecksum`,
 * whatever their names, tags or covers), and probable ones, the same artist and title (folded as
 * the iPod's check folds them) with audio that differs. Of exact copies one is kept, the one best
 * placed and tagged; of probable ones none is chosen, the best in quality is only pointed out.
 * See RECORD/2026-11-03.deck-design-system.WIP.md (2026-11-16 00:55).
 */

import type { Track } from "../types.ts";
import { folded, songKey } from "./ipod.ts";

/** A group of copies: their tracks' ids, and the title and artist to name it by. */
export type DuplicateGroup = { key: string; title: string; artist: string; trackIds: string[] };

export type Duplicates = {
  /** The same audio. */
  exact: DuplicateGroup[];
  /** The same artist and title, the audio not the same. */
  probable: DuplicateGroup[];
};

const folderOf = (path: string): string => path.slice(0, path.lastIndexOf("/") + 1);
const isLossless = (path: string): boolean => /\.(flac|wav|aiff?|alac|ape|wv)$/i.test(path);

/** How full a track's tags are: title, artist, album, track, year, each that is there. */
export function tagsFilled(track: Pick<Track, "metadata">): number {
  const { title, artist, album, trackNumber, year } = track.metadata;
  return [title, artist, album, trackNumber, year].filter((value) => value.trim() !== "").length;
}

/**
 * Which of an exact group to keep: the copy in its album's folder (where most tracks share its
 * album tag, so no album is left short), then the one with the fullest tags, then one with a cover,
 * then the shortest path (then the first by path, so it is always the same one).
 */
export function keptOf(group: readonly Track[], all: readonly Track[]): Track {
  const albumMates = (track: Track): number => {
    const folder = folderOf(track.relativePath);
    const album = folded(track.metadata.album);
    if (!album) return 0;
    return all.filter((other) => folderOf(other.relativePath) === folder && folded(other.metadata.album) === album).length;
  };
  return [...group].sort(
    (a, b) =>
      albumMates(b) - albumMates(a) ||
      tagsFilled(b) - tagsFilled(a) ||
      Number(!!b.metadata.coverDataUrl) - Number(!!a.metadata.coverDataUrl) ||
      a.relativePath.length - b.relativePath.length ||
      a.relativePath.localeCompare(b.relativePath)
  )[0];
}

/** The best in quality of a probable group: lossless before lossy, then the highest bit rate (the largest where it is not known). */
export function bestOf(group: readonly Track[]): Track {
  return [...group].sort(
    (a, b) =>
      Number(isLossless(b.relativePath)) - Number(isLossless(a.relativePath)) ||
      (b.audio?.bitrate ?? 0) - (a.audio?.bitrate ?? 0) ||
      b.size - a.size ||
      a.relativePath.localeCompare(b.relativePath)
  )[0];
}

const named = (key: string, tracks: Track[]): DuplicateGroup => ({
  key,
  title: tracks[0].metadata.title || tracks[0].name,
  artist: tracks[0].metadata.artist,
  trackIds: tracks.map((track) => track.id)
});

/** A root's duplicates, each group's tracks in path order, the groups by title. */
export function findDuplicates(tracks: readonly Track[]): Duplicates {
  const byPath = [...tracks].sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  const byAudio = new Map<string, Track[]>();
  const bySong = new Map<string, Track[]>();
  for (const track of byPath) {
    if (track.audioChecksum) byAudio.set(track.audioChecksum, [...(byAudio.get(track.audioChecksum) ?? []), track]);
    // A song with no title is never a probable copy: there is nothing to tell it by.
    if (folded(track.metadata.title)) {
      const key = songKey(track.metadata);
      bySong.set(key, [...(bySong.get(key) ?? []), track]);
    }
  }
  const order = (a: DuplicateGroup, b: DuplicateGroup) => a.title.localeCompare(b.title) || a.artist.localeCompare(b.artist);
  const exact = [...byAudio].filter(([, group]) => group.length > 1).map(([key, group]) => named(`audio:${key}`, group));
  // Probable: more than one audio among them (or one unknown beside another); exact copies alone are not.
  const probable = [...bySong]
    .filter(([, group]) => group.length > 1 && (new Set(group.map((track) => track.audioChecksum || `?${track.id}`)).size > 1))
    .map(([key, group]) => named(`song:${key}`, group));
  return { exact: exact.sort(order), probable: probable.sort(order) };
}

/** The extra copies of exact groups: all but the one kept in each. */
export function extraCopies(groups: readonly DuplicateGroup[], tracks: readonly Track[]): string[] {
  const byId = new Map(tracks.map((track) => [track.id, track]));
  return groups.flatMap((group) => {
    const members = group.trackIds.flatMap((id) => byId.get(id) ?? []);
    const kept = keptOf(members, tracks).id;
    return group.trackIds.filter((id) => id !== kept);
  });
}
