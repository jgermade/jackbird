/**
 * A root's lists, as the Lists view and Details show them: first "All songs" (every song of the
 * root, by title; no file of its own, so it is neither renamed nor deleted), then the liked songs,
 * then the playlists by name. Details draws each as a card of its own, its songs in its order
 * (`listCards`). See RECORD/2026-11-03.deck-design-system.WIP.md (2026-11-24, "Lists").
 */

import type { Playlist, Track } from "../types.ts";
import { compareText } from "./compare.ts";
import { isLikedPath } from "./playlists.ts";

/** The key of "All songs", in the library's rows (its group) and in Details (its card). */
export const ALL_SONGS_KEY = "@all-songs";

/** A playlist's key, in the library's rows and in Details. */
export const playlistKey = (path: string): string => `@playlist:${path}`;

/** Every song, by title (then by path, for two of one title). */
export function songsByTitle<T extends Pick<Track, "name" | "relativePath" | "metadata">>(tracks: readonly T[], locale: string): T[] {
  return [...tracks].sort((left, right) => compareText(left.metadata.title || left.name, right.metadata.title || right.name, locale) || left.relativePath.localeCompare(right.relativePath));
}

/** The playlists in the order they are listed: the liked songs first, the others by name. */
export function sortedPlaylists<P extends Pick<Playlist, "path" | "name">>(playlists: readonly P[], locale: string): P[] {
  return [...playlists].sort((left, right) => Number(isLikedPath(right.path)) - Number(isLikedPath(left.path)) || compareText(left.name, right.name, locale));
}

/** One song of a list's card: found in the root, or an entry whose file is not there. */
export type ListEntry = {
  /** Unique in its card: the song's id, or the entry's place for one missing. */
  key: string;
  /** Its place in the list (a playlist's entry index). */
  index: number;
  trackId?: string;
  title: string;
  /** Who and which album, under its title. */
  sub: string;
  /** Its own cover, by reference (`jackbird-cover:<name>`); none for a song without one, or missing. */
  cover?: string;
  missing: boolean;
};

/** A list as Details shows it. */
export type ListCard = {
  key: string;
  name: string;
  kind: "all" | "liked" | "playlist";
  /** A playlist's file (the liked songs' too); none for "All songs". */
  path?: string;
  entries: ListEntry[];
  /** Its songs found, in its order: what plays. */
  trackIds: string[];
  /** How long its songs found last, all told. */
  durationMs: number;
};

type CardTrack = Pick<Track, "id" | "name" | "relativePath" | "metadata" | "audio">;

const byWhom = (track: CardTrack): string => [track.metadata.artist.trim(), track.metadata.album.trim()].filter(Boolean).join(" - ");

function card(key: string, name: string, kind: ListCard["kind"], found: (CardTrack | undefined)[], titles: string[], path?: string): ListCard {
  const entries = found.map((track, index): ListEntry =>
    track
      ? { key: track.id, index, trackId: track.id, title: track.metadata.title || track.name, sub: byWhom(track), ...(track.metadata.coverDataUrl ? { cover: track.metadata.coverDataUrl } : {}), missing: false }
      : { key: `#${index}`, index, title: titles[index] ?? "", sub: "", missing: true }
  );
  const songs = found.filter((track): track is CardTrack => !!track);
  return {
    key,
    name,
    kind,
    ...(path ? { path } : {}),
    entries,
    trackIds: songs.map((track) => track.id),
    durationMs: songs.reduce((sum, track) => sum + (track.audio?.durationMs ?? 0), 0)
  };
}

/**
 * The cards of a root's lists, in the order they are listed; only the one of key `chosen` when it is
 * one of them (a list, or a song of one, is the library's current row).
 */
export function listCards(
  tracks: readonly CardTrack[],
  playlists: readonly Playlist[],
  labels: { allSongs: string; liked: string; locale: string },
  chosen: string | null = null
): ListCard[] {
  const wanted = (key: string): boolean => chosen === null || chosen === key;
  const known = chosen === null || chosen === ALL_SONGS_KEY || playlists.some((playlist) => playlistKey(playlist.path) === chosen);
  const want = known ? wanted : () => true;
  const cards: ListCard[] = [];
  if (want(ALL_SONGS_KEY)) {
    const all = songsByTitle(tracks, labels.locale);
    cards.push(card(ALL_SONGS_KEY, labels.allSongs, "all", all, []));
  }
  const byPath = new Map(tracks.map((track) => [track.relativePath, track]));
  for (const playlist of sortedPlaylists(playlists, labels.locale)) {
    const key = playlistKey(playlist.path);
    if (!want(key)) continue;
    const liked = isLikedPath(playlist.path);
    const found = playlist.entries.map((entry) => (entry.path ? byPath.get(entry.path) : undefined));
    const titles = playlist.entries.map((entry) => entry.title || entry.raw.split(/[\\/]/).pop() || entry.raw);
    cards.push(card(key, liked ? labels.liked : playlist.name, liked ? "liked" : "playlist", found, titles, playlist.path));
  }
  return cards;
}
