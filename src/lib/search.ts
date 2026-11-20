// Searching the songs of the open tab (helpers/search.ts). On a phone, pulled down from the top of
// the library or of Details, a field under the tabs with its results over the panes
// (views/search-bar.html); on a computer, a dialog (views/search-dialog.html), opened with its key
// in the tabs' bar, Ctrl or ⌘ with F, or "/". A few artists and albums first (their name, or the
// album's and its artist's), then the songs, each read as a row of the queue: the cover, the
// title, "artist - album" under it, and the length in its codec's colour. Choosing a song shows it
// in Details, scrolled to it (lib/workspace.ts `revealTrack`); an artist or an album, its group in
// Artists or Albums (`goToGroup`). See
// RECORD/2026-11-03.deck-design-system.WIP.md (2026-11-20).

import { $computed, $reactive, $toRaw } from "jq79";
import { formatDuration } from "../helpers/format";
import { codecFamily, codecLabel } from "../helpers/formats";
import { searchIndex, searchIndexed, type Indexed } from "../helpers/search";
import { albumKey, artistKey } from "../helpers/views";
import type { Track } from "../types";
import { library } from "./library";
import { Opaque } from "./opaque";
import { ui } from "./ui";
import { goToGroup, revealTrack } from "./workspace";

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

/** An artist or an album found: its name, what goes under it, a song of it (to go to it), a cover. */
export type SearchGroup = { key: string; kind: "artist" | "album"; title: string; sub: string; trackId: string; cover: string | null; count: number };

/** As many artists, and as many albums, as are shown above the songs. */
export const GROUP_LIMIT = 4;

// Each tab's artists and albums, gathered and folded once, while they are the same songs.
type Groups = { artists: Indexed<SearchGroup>[]; albums: Indexed<SearchGroup>[] };
const groupIndexes = new WeakMap<readonly Track[], Groups>();
function groupsOf(tracks: readonly Track[]): Groups {
  let found = groupIndexes.get(tracks);
  if (!found) {
    const artists = new Map<string, SearchGroup>();
    const albums = new Map<string, SearchGroup>();
    for (const track of tracks) {
      const artist = track.metadata.artist.trim();
      if (artist) {
        const key = artistKey(track);
        const group = artists.get(key) ?? { key, kind: "artist" as const, title: artist, sub: "", trackId: track.id, cover: null, count: 0 };
        group.count += 1;
        group.cover ??= track.metadata.coverDataUrl ?? null;
        artists.set(key, group);
      }
      const album = track.metadata.album.trim();
      if (album) {
        const key = albumKey(track);
        const by = track.metadata.albumArtist.trim() || artist;
        const group = albums.get(key) ?? { key, kind: "album" as const, title: album, sub: by, trackId: track.id, cover: null, count: 0 };
        group.count += 1;
        group.cover ??= track.metadata.coverDataUrl ?? null;
        albums.set(key, group);
      }
    }
    const indexed = (groups: Iterable<SearchGroup>): Indexed<SearchGroup>[] =>
      searchIndex([...groups].map((group) => ({ group, title: group.title, artist: group.sub }))).map((item) => ({ ...item, song: item.song.group }));
    found = { artists: indexed(artists.values()), albums: indexed(albums.values()) };
    groupIndexes.set(tracks, found);
  }
  return found;
}

type Found = { artists: SearchGroup[]; albums: SearchGroup[]; results: SearchResult[]; total: number };
const NOTHING: Found = { artists: [], albums: [], results: [], total: 0 };

/** What the query finds in the open tab: a few artists and albums, the first songs, and how many songs in all. */
export const searchResults = $computed((): Opaque<Found> => {
  const query = search.query;
  const id = library.activeRootId;
  const root = $toRaw(library.roots).find((item) => item.id === id);
  if (!root || !query.trim()) return new Opaque(NOTHING);
  const { found, total } = searchIndexed(indexOf(root.tracks), query, SEARCH_LIMIT);
  const groups = groupsOf(root.tracks);
  return new Opaque({
    artists: searchIndexed(groups.artists, query, GROUP_LIMIT).found,
    albums: searchIndexed(groups.albums, query, GROUP_LIMIT).found,
    results: found.map(resultOf),
    total
  });
});

/** Opens the search, as it was left (its query kept, to go on from it). */
export function openSearch(): void {
  search.open = true;
}

export function closeSearch(): void {
  search.open = false;
}

// When an empty search last closed for losing the focus (`leaveSearch`): pressing the search's key
// takes the focus from the field before its click, so that click must not open it again.
let leftAt = 0;
const LEFT_JUST_NOW_MS = 300;

/** An empty search left (its field lost the focus): it closes. */
export function leaveSearch(): void {
  search.open = false;
  leftAt = Date.now();
}

/** The search's key: it opens the search, and closes it while open. */
export function toggleSearch(): void {
  const justLeft = Date.now() - leftAt < LEFT_JUST_NOW_MS;
  leftAt = 0;
  if (search.open) search.open = false;
  else if (!justLeft) search.open = true;
}

/** An artist or an album chosen: the search closes, and Details shows it (in Artists or Albums). */
export function chooseGroup(trackId: string, kind: "artist" | "album"): void {
  search.open = false;
  goToGroup(trackId, kind);
  ui.pane = "details";
}

/** A result chosen: the search closes, and Details shows the song. */
export function chooseResult(trackId: string): void {
  const id = library.activeRootId;
  search.open = false;
  if (id) revealTrack(id, trackId, true);
}
