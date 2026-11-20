// Searching the songs of the open tab (helpers/search.ts). On a phone, pulled down from the top of
// the library or of Details, a field under the tabs with its results over the panes
// (views/search-bar.html); on a computer, a dialog (views/search-dialog.html), opened with its key
// in the library's head, Ctrl or ⌘ with F, or "/". Each result reads as a row of the queue: the
// cover, the title, "artist - album" under it, and the length in its codec's colour. Choosing one
// shows it in Details, scrolled to it (lib/workspace.ts `revealTrack`). See
// RECORD/2026-11-03.deck-design-system.WIP.md (2026-11-20).

import { $computed, $reactive, $toRaw } from "jq79";
import { formatDuration } from "../helpers/format";
import { codecFamily, codecLabel } from "../helpers/formats";
import { searchIndex, searchIndexed, type Indexed } from "../helpers/search";
import type { Track } from "../types";
import { library } from "./library";
import { Opaque } from "./opaque";
import { revealTrack } from "./workspace";

/** As many results as are drawn: past them, the count says how many more. */
export const SEARCH_LIMIT = 200;

export const search = $reactive({
  open: false,
  query: ""
});

/** One result, as the queue draws a track. */
export type SearchResult = { id: string; title: string; artist: string; album: string; duration: string; codec: string; cover: string | null };

const resultOf = (track: Track): SearchResult => ({
  id: track.id,
  title: track.metadata.title || track.name,
  artist: track.metadata.artist ?? "",
  album: track.metadata.album ?? "",
  duration: formatDuration(track.audio?.durationMs),
  codec: codecFamily(codecLabel(track.relativePath, track.audio)),
  cover: track.metadata.coverDataUrl ?? null
});

// Each tab's songs folded once, while they are the same songs.
const indexes = new WeakMap<readonly Track[], Indexed<Track>[]>();
function indexOf(tracks: readonly Track[]): Indexed<Track>[] {
  let index = indexes.get(tracks);
  if (!index) {
    index = searchIndex(
      tracks.map((track) => ({ track, title: track.metadata.title || track.name, artist: track.metadata.artist, album: track.metadata.album, albumArtist: track.metadata.albumArtist, name: track.name }))
    ).map((item) => ({ ...item, song: item.song.track }));
    indexes.set(tracks, index);
  }
  return index;
}

/** What the query finds in the open tab: the first ones, and how many there are in all. */
export const searchResults = $computed((): Opaque<{ results: SearchResult[]; total: number }> => {
  const query = search.query;
  const id = library.activeRootId;
  const root = $toRaw(library.roots).find((item) => item.id === id);
  if (!root || !query.trim()) return new Opaque({ results: [], total: 0 });
  const { found, total } = searchIndexed(indexOf(root.tracks), query, SEARCH_LIMIT);
  return new Opaque({ results: found.map(resultOf), total });
});

/** Opens the search, as it was left (its query kept, to go on from it). */
export function openSearch(): void {
  search.open = true;
}

export function closeSearch(): void {
  search.open = false;
}

/** A result chosen: the search closes, and Details shows the song. */
export function chooseResult(trackId: string): void {
  const id = library.activeRootId;
  search.open = false;
  if (id) revealTrack(id, trackId, true);
}
