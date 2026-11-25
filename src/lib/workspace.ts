// The active root: what the library shows of it (the tree, the album sheet's
// scope, the selection) and what can be done in it. The computed values read
// plain objects and wake when `library.roots` or `library.activeRootId` is
// replaced, which is how every write reaches them (see updateRoots). The
// actions write the library store; the views read it.

import { $computed, $toRaw } from "jq79";
import { groupAlbums, type AlbumGroup } from "../helpers/albums";
import { queueOf } from "../helpers/queue";
import { byCaret, followFolder, oneTopOpen } from "../helpers/follow";
import { withoutSongs } from "../helpers/folders";
import { levelsOf, openOnEntering, openOnLeaving, type Levels } from "../helpers/levels";
import { listCards, type ListCard } from "../helpers/lists";
import { shuffledOrder } from "../helpers/order";
import { detailScope, scopeCrumbs, type Crumb, type Scope } from "../helpers/scope";
import { dialogTrackIds, nextSelection, selectMany } from "../helpers/selection";
import { collectFolderPaths, orderDetailPlaylist } from "../helpers/tracks";
import { buildWizardRows, treeKeyAction } from "../helpers/tree";
import { albumKey, artistKey, buildViewRows, trackPlace, type ViewLabels } from "../helpers/views";
import type { LibraryView, Track, RootWorkspace, WizardTreeRow } from "../types";
import { t, tn } from "./i18n";
import { library } from "./library";
import { addToQueue, dropFromQueue, nowPlaying, playNext, playTracks, togglePlay } from "./player";
import { preferences } from "./preferences";
import { updateRoots } from "./roots";
import { ui } from "./ui";
import { showToast } from "./toast";

import { Opaque } from "./opaque";

export { Opaque };

type Derived = {
  root: RootWorkspace | null;
  rows: WizardTreeRow[];
  scope: Scope;
  crumbs: Crumb[];
};

// The last derivation, keyed on the roots array, the active id, the
// language (the views' labels) and whether the tree shows the songs: every
// write replaces the array (updateRoots), so identity is enough.
let cache: { roots: RootWorkspace[]; id: string | null; language: string; songs: boolean; derived: Derived } | null = null;

/** The words the views need, in the interface's language. */
function viewLabels(): ViewLabels {
  return {
    unknownArtist: t("album.unknownArtist"),
    unknownAlbum: t("album.untitled"),
    variousArtists: t("views.variousArtists"),
    missing: t("playlist.missing"),
    liked: t("likes.list"),
    allSongs: t("lists.allSongs"),
    locale: preferences.language
  };
}

/** A root's rows in its view: its folders (Files), or the view's groups. */
function rowsOf(root: RootWorkspace): WizardTreeRow[] {
  const view = root.view ?? "files";
  return view === "files"
    ? buildWizardRows(root.tracks, root.expandedAlbums)
    : buildViewRows(view, root.tracks, root.expandedAlbums, viewLabels(), root.playlists ?? [], root.metaSnapshot.artists ?? {});
}

/**
 * The active root, its tree rows and the sheet's scope, worked out once per
 * change of the library. Each $computed below calls this rather than reading
 * another $computed: a $computed that reads another one's object value wakes
 * itself again (jq79 gives up after 100 rounds), and reading the library
 * store directly does not. Inside an effect, the two reads here are what it
 * depends on.
 */
function derive(): Derived {
  const roots = $toRaw(library.roots);
  const id = library.activeRootId;
  const language = preferences.language;
  const root = roots.find((item) => item.id === id) ?? null;
  // Files and the other views each show their songs or not (two preferences).
  const songs = (root?.view ?? "files") === "files" ? preferences.songsInFolders : preferences.songsInViews;
  if (cache && cache.roots === roots && cache.id === id && cache.language === language && cache.songs === songs) {
    return cache.derived;
  }
  const all = root ? rowsOf(root) : [];
  // Without the songs (a preference), the tree shows and walks the folders only; what Details
  // shows, and its breadcrumb, are still worked out from every row.
  const rows = root && !songs ? withoutSongs(all, root.view ?? "files", root.tracks) : all;
  // The same scope as before (a whole root, kept from one view to another) is the same object, so
  // the album sheet, which a new one draws again whole, is not drawn again.
  const scope = sameScope(cache?.derived.scope, detailScope(root, all));
  const derived = { root, rows, scope, crumbs: scopeCrumbs(root, all) };
  cache = { roots, id, language, songs, derived };
  return derived;
}

function sameScope(before: Scope | undefined, after: Scope): Scope {
  return before && before.label === after.label && before.tracks === after.tracks && before.ordered === after.ordered && before.whole === after.whole ? before : after;
}

/** A box for `data` that is the last one when `data` is the same: a computed that gets it does not wake its views. */
function boxer<T>(): (data: T) => Opaque<T> {
  let last: Opaque<T> | null = null;
  return (data) => (last && last.data === data ? last : (last = new Opaque(data)));
}

export const activeRoot = $computed((): Opaque<RootWorkspace | null> => new Opaque(derive().root));

/** The tree's visible rows, in order. */
export const treeRows = $computed((): Opaque<WizardTreeRow[]> => new Opaque(derive().rows));

/** A phone's list of the same rows: the open folders, one per level, and what the last one holds (helpers/levels.ts). */
export const treeLevels = $computed((): Opaque<Levels> => new Opaque(levelsOf(derive().rows)));

/** What the album sheet shows. */
const detailBox = boxer<Scope>();
export const detail = $computed((): Opaque<Scope> => detailBox(derive().scope));

/** Where the album sheet's scope comes from, as a breadcrumb (helpers/scope.ts). */
export const detailCrumbs = $computed((): Opaque<Crumb[]> => new Opaque(derive().crumbs));

/** Back to the whole root in the album sheet: no current row. */
export function showWhole(): void {
  updateActive((root) => (root.activeRowKey === null ? root : { ...root, activeRowKey: null }));
}

/** The sheet's tracks as albums and discs, titled in the current language. */
let albumsOf: { tracks: Track[]; untitled: string; language: string; byYear: boolean; box: Opaque<AlbumGroup[]> } | null = null;
export const detailAlbums = $computed((): Opaque<AlbumGroup[]> => {
  const { scope, root } = derive();
  const tracks = scope.tracks;
  const untitled = t("album.untitled");
  const language = preferences.language;
  // Albums by artist: by year, as the library lists them.
  const byYear = root?.view === "albumsByArtist";
  if (!albumsOf || albumsOf.tracks !== tracks || albumsOf.untitled !== untitled || albumsOf.language !== language || albumsOf.byYear !== byYear) {
    albumsOf = { tracks, untitled, language, byYear, box: new Opaque(groupAlbums(tracks, untitled, language, byYear)) };
  }
  return albumsOf.box;
});

/**
 * The Lists view's Details: a card per list (helpers/lists.ts), or only the one chosen in the
 * library (a list, or a song of one). Empty in the other views.
 */
let cardsOf: { roots: RootWorkspace[]; id: string | null; key: string | null; language: string; box: Opaque<ListCard[]> } | null = null;
export const detailLists = $computed((): Opaque<ListCard[]> => {
  const { root, rows } = derive();
  const roots = $toRaw(library.roots);
  const language = preferences.language;
  if (!root || root.view !== "playlists") return new Opaque([]);
  const row = root.activeRowKey ? rows.find((item) => item.key === root.activeRowKey) : undefined;
  const group = row?.kind === "album" ? row : row?.parentKey ? rows.find((item) => item.key === row.parentKey) : undefined;
  const key = group?.key ?? null;
  if (!cardsOf || cardsOf.roots !== roots || cardsOf.id !== root.id || cardsOf.key !== key || cardsOf.language !== language) {
    const cards = listCards(root.tracks, root.playlists ?? [], { allSongs: t("lists.allSongs"), liked: t("likes.list"), locale: language }, key);
    cardsOf = { roots, id: root.id, key, language, box: new Opaque(cards) };
  }
  return cardsOf.box;
});

export const selectedTracks = $computed((): Opaque<Track[]> => {
  const { root } = derive();
  if (!root || root.selectedTrackIds.length === 0) {
    return new Opaque([]);
  }
  const selected = new Set(root.selectedTrackIds);
  return new Opaque(root.tracks.filter((track) => selected.has(track.id)));
});

/**
 * The tracks the selection dialog works on (boxed): those of a track's menu (`ui.selectionTargets`),
 * else the selection; in the library's order.
 */
export const dialogTracks = $computed((): Opaque<Track[]> => {
  const { root } = derive();
  const targets = ui.selectionTargets ? [...$toRaw(ui.selectionTargets)] : null;
  if (!root) return new Opaque([]);
  const ids = new Set(dialogTrackIds(root.selectedTrackIds, targets));
  return new Opaque(ids.size === 0 ? [] : root.tracks.filter((track) => ids.has(track.id)));
});

/** The active root as a plain object. */
function current(): RootWorkspace | null {
  return derive().root;
}

/**
 * A scope's tracks in the order they play: a view's own, else the album sheet's (its albums by
 * title, each by disc and number, then file name), so the queue reads as the sheet does.
 */
function playOrder(scope: Scope): Track[] {
  if (scope.ordered) return scope.tracks;
  return groupAlbums(scope.tracks, t("album.untitled"), preferences.language, derive().root?.view === "albumsByArtist").flatMap((album) => album.discs.flatMap((disc) => disc.tracks));
}

function updateActive(update: (root: RootWorkspace) => RootWorkspace): void {
  const id = $toRaw(library).activeRootId;
  if (id) {
    updateRoots((roots) => roots.map((root) => (root.id === id ? update(root) : root)));
  }
}

function clearedSelection(root: RootWorkspace): RootWorkspace {
  return { ...root, selectedTrackId: null, selectedTrackIds: [], selectionAnchorTrackId: null };
}

/**
 * A click on a track's box: `toggle` (plain) adds or removes it, `range`
 * (Shift) selects from the anchor to it, in the tree's order. It does not
 * move the current row: selecting in the album sheet leaves what the sheet
 * shows alone.
 */
export function selectTrack(trackId: string, mode: "toggle" | "range" = "toggle"): void {
  const root = current();
  if (!root) {
    return;
  }
  const shown = derive().rows.flatMap((row) => (row.kind === "track" && row.trackId ? [row.trackId] : []));
  const order = shown.length > 0 ? shown : root.tracks.map((track) => track.id);

  updateActive((item) => {
    const { selected, anchor } = nextSelection({ selected: item.selectedTrackIds, anchor: item.selectionAnchorTrackId }, trackId, mode, order);
    return {
      ...item,
      selectedTrackId: selected.length === 1 ? selected[0] : null,
      selectedTrackIds: [...selected],
      selectionAnchorTrackId: anchor
    };
  });
  library.infoMessage = null;
  library.errorMessage = null;
}

/**
 * Selects all of `trackIds` (`on`) or none of them (a disc's box in the album
 * sheet), the rest of the selection as it was. The current row stays.
 */
export function selectTracks(trackIds: readonly string[], on: boolean): void {
  updateActive((item) => {
    const { selected, anchor } = selectMany({ selected: item.selectedTrackIds, anchor: item.selectionAnchorTrackId }, trackIds, on);
    return {
      ...item,
      selectedTrackId: selected.length === 1 ? selected[0] : null,
      selectedTrackIds: [...selected],
      selectionAnchorTrackId: selected.length > 0 ? anchor : null
    };
  });
  library.infoMessage = null;
  library.errorMessage = null;
}

/**
 * Makes a tree row the current one, the row the keyboard is on: a folder
 * scopes the album sheet, a track shows its folder. The selection stays.
 */
export function setCurrentRow(rowKey: string): void {
  updateActive((root) => (root.activeRowKey === rowKey ? root : { ...root, activeRowKey: rowKey }));
}

/**
 * A key on the tree: the arrows move and open or close folders, Enter plays
 * the current row, Space picks the current track (Shift: up to it). True when
 * the tree took it, so the view can stop the page scrolling.
 */
export function navigateTree(key: string, shiftKey = false, levels = false): boolean {
  const root = current();
  // A phone's levels: the keys move over what it lists, and open and close a folder as a tap does.
  const listed = levels ? levelsOf(derive().rows) : null;
  const rows = listed ? [...listed.open, ...listed.rows] : derive().rows;
  const action = treeKeyAction(rows, root?.activeRowKey ?? null, key, shiftKey);
  if (action && "toggle" in action) {
    const folder = rows.find((row) => row.kind === "album" && row.album === action.toggle);
    if (!listed || !folder) toggleFolder(action.toggle);
    else if (folder.expanded) leaveLevel(folder.key);
    else enterLevel(folder.key);
  } else if (action && "move" in action) {
    setCurrentRow(action.move);
  } else if (action && "play" in action) {
    playFromTree(action.play);
  } else if (action) {
    selectTrack(action.pick, action.range ? "range" : "toggle");
  }
  return rows.length > 0 && (key.startsWith("Arrow") || key === " " || key === "Enter");
}

export function clearSelection(): void {
  updateActive(clearedSelection);
}

export function toggleFolder(folder: string): void {
  const id = library.activeRootId;
  if (id) autoOpened.set(id, byCaret(autoOpened.get(id) ?? [], folder));
  const tops = artistTops();
  updateActive((root) => {
    if (root.expandedAlbums.includes(folder)) return { ...root, expandedAlbums: root.expandedAlbums.filter((value) => value !== folder) };
    // An artist opened in Albums by artist: the others close.
    const opened = [...root.expandedAlbums, folder];
    return { ...root, expandedAlbums: tops.includes(folder) ? oneTopOpen(opened, tops, folder) : opened };
  });
}

/** In Albums by artist, its artists' keys (the groups at the top), which open one at a time; else none. */
function artistTops(): string[] {
  const { root, rows } = derive();
  return root?.view === "albumsByArtist" ? rows.filter((row) => row.kind === "album" && row.depth === 0).map((row) => row.album) : [];
}

/** The folders of each root a click opened (not their caret): they close as the current row leaves them. */
const autoOpened = new Map<string, string[]>();

/**
 * A click on a row on a computer: it becomes current, a folder opens (closing again once the
 * current row leaves it, unless its caret opened it) and the folders a click opened that do not
 * hold it close (helpers/follow.ts).
 */
export function followRow(rowKey: string): void {
  const root = current();
  const rows = derive().rows;
  const row = rows.find((item) => item.key === rowKey);
  if (!root || !row) return;
  const byKey = new Map(rows.map((item) => [item.key, item]));
  const ancestors: string[] = [];
  for (let up = row.parentKey ? byKey.get(row.parentKey) : undefined; up; up = up.parentKey ? byKey.get(up.parentKey) : undefined) {
    if (up.kind === "album") ancestors.push(up.album);
  }
  const next = followFolder({ expanded: root.expandedAlbums, auto: autoOpened.get(root.id) ?? [] }, row.kind === "album" ? row.album : null, ancestors);
  // Albums by artist: the artist holding the row (the farthest folder up, or the row itself) the
  // only one open (the owner, 2026-11-25).
  const tops = artistTops();
  const artist = ancestors.at(-1) ?? (row.kind === "album" ? row.album : null);
  const expanded = tops.length > 0 ? oneTopOpen(next.expanded, tops, artist) : next.expanded;
  autoOpened.set(root.id, next.auto.filter((key) => expanded.includes(key)));
  updateActive((item) => ({ ...item, activeRowKey: rowKey, expandedAlbums: expanded }));
}

/**
 * A tap on a folder's row on a phone: its content takes the list (it and the folders above it the
 * only ones open of those listed), and it becomes the current row, so the album sheet is on it.
 */
export function enterLevel(rowKey: string): void {
  const root = current();
  const rows = derive().rows;
  if (!root || !rows.some((row) => row.key === rowKey)) return;
  // None is "opened by a click" any more: a computer's tree would close them behind the current row.
  autoOpened.set(root.id, []);
  updateActive((item) => ({ ...item, activeRowKey: rowKey, expandedAlbums: openOnEntering(rows, item.expandedAlbums, rowKey) }));
}

/**
 * A tap on an open level's row on a phone: it closes, with the ones under it, and the list is
 * back at the level that holds it, which becomes the current row (at the top, none: the whole root).
 */
export function leaveLevel(rowKey: string): void {
  const root = current();
  const rows = derive().rows;
  const row = rows.find((item) => item.key === rowKey);
  if (!root || !row) return;
  autoOpened.set(root.id, []);
  updateActive((item) => ({ ...item, activeRowKey: row.parentKey, expandedAlbums: openOnLeaving(rows, item.expandedAlbums, rowKey) }));
}

/** Lists the active root by `view`; the current row stays if the view has it. */
export function setView(view: LibraryView): void {
  updateActive((root) => (root.view === view ? root : { ...root, view }));
}

/**
 * Goes to a track's album or artist: the library switches to Albums or
 * Artists, with that group as its current row (so Details shows it).
 */
export function goToGroup(trackId: string, group: "album" | "artist"): void {
  const track = current()?.tracks.find((item) => item.id === trackId);
  if (!track) {
    return;
  }
  const view: LibraryView = group === "album" ? "albums" : "artists";
  const key = group === "album" ? albumKey(track) : artistKey(track);
  updateActive((root) => ({ ...root, view, activeRowKey: key }));
}

/** Drops the selected tracks from the library (not from disk): they come back when the folder is opened again. */
export function removeSelectedTracks(): void {
  const root = current();
  if (!root) {
    return;
  }
  const targets = $toRaw(ui).selectionTargets;
  const gone = new Set(dialogTrackIds(root.selectedTrackIds, targets));
  if (gone.size === 0) {
    return;
  }
  // They leave the queue first (if the one playing goes, the next one plays), then the library. Those
  // of a track's menu leave the selection as it is, but for any of them in it.
  dropFromQueue((item) => item.rootId === root.id && gone.has(item.trackId));
  const kept = (item: RootWorkspace): RootWorkspace => {
    if (!targets) return clearedSelection(item);
    const selected = item.selectedTrackIds.filter((id) => !gone.has(id));
    const keep = (id: string | null): string | null => (id && !gone.has(id) ? id : null);
    return { ...item, selectedTrackIds: selected, selectedTrackId: keep(item.selectedTrackId), selectionAnchorTrackId: keep(item.selectionAnchorTrackId) };
  };
  updateActive((item) => ({ ...kept(item), tracks: item.tracks.filter((track) => !gone.has(track.id)) }));
  ui.selectionTargets = null;
  library.infoMessage = tn("message.removed", gone.size);
}

/** Plays the album sheet's tracks from `trackId`; the one already playing pauses or resumes. */
export function playFromDetail(trackId: string): void {
  const root = current();
  const scope = derive().scope;
  if (!root || scope.tracks.length === 0) {
    return;
  }
  const playing = $toRaw(nowPlaying.value);
  if (playing && playing.rootId === root.id && playing.trackId === trackId) {
    togglePlay();
    return;
  }
  const trackIds = playOrder(scope).map((track) => track.id);
  const index = trackIds.indexOf(trackId);
  if (index !== -1) {
    playTracks(queueOf(root.id, trackIds, scope.label).items, index, scope.label);
  }
}

/** Plays `trackIds` of the active root (an album of the sheet), in that order, from the first. */
export function playTrackIds(trackIds: readonly string[], label: string): void {
  const root = current();
  if (root && trackIds.length > 0) playTracks(queueOf(root.id, [...trackIds], label).items, 0, label);
}

/** What Details shows (its scope), as it plays: its tracks' ids in the sheet's order, and its name. */
export function detailPlayList(): { trackIds: string[]; label: string } {
  const scope = derive().scope;
  return { trackIds: playOrder(scope).map((track) => track.id), label: scope.label };
}

/** Plays tracks of the active root in an order of chance, `label` the queue's name. */
export function shuffleTrackIds(trackIds: readonly string[], label: string): void {
  const root = current();
  if (!root || trackIds.length === 0) return;
  const order = shuffledOrder(trackIds.length, Math.floor(Math.random() * trackIds.length));
  playTrackIds(order.map((at) => trackIds[at]), label);
}

/** Plays a list's songs from one of them (Details' Lists): the one playing pauses or resumes. */
export function playFromList(trackIds: readonly string[], trackId: string, label: string): void {
  const root = current();
  if (!root) return;
  const playing = $toRaw(nowPlaying.value);
  if (playing && playing.rootId === root.id && playing.trackId === trackId) {
    togglePlay();
    return;
  }
  const index = trackIds.indexOf(trackId);
  if (index !== -1) playTracks(queueOf(root.id, [...trackIds], label).items, index, label);
}

/**
 * Plays from a tree row. A track plays its folder (what the album sheet shows
 * for that row) from that track, or pauses and resumes it if it is the one
 * playing; a folder plays the tracks under it from the first.
 */
export function playFromTree(rowKey: string): void {
  const { root, rows } = derive();
  const row = rows.find((item) => item.key === rowKey);
  if (!root || !row || (row.kind !== "track" && row.kind !== "album")) {
    return;
  }
  const playing = $toRaw(nowPlaying.value);
  if (row.kind === "track" && playing && playing.rootId === root.id && playing.trackId === row.trackId) {
    togglePlay();
    return;
  }
  const scope = detailScope({ ...root, activeRowKey: rowKey }, rows);
  const trackIds = playOrder(scope).map((track) => track.id);
  const index = row.kind === "track" && row.trackId ? placeOf(row, rows, trackIds) : 0;
  if (trackIds.length > 0 && index !== -1) {
    playTracks(queueOf(root.id, trackIds, scope.label).items, index, scope.label);
  }
}

/**
 * Where a track row is in the tracks it plays with: a playlist's entry by its
 * place (a track can be in a playlist twice; the missing entries before it
 * do not count), any other track by its id.
 */
function placeOf(row: WizardTreeRow, rows: readonly WizardTreeRow[], trackIds: readonly string[]): number {
  if (row.playlistIndex === undefined) {
    return trackIds.indexOf(row.trackId ?? "");
  }
  return rows.filter((other) => other.parentKey === row.parentKey && other.trackId && (other.playlistIndex ?? 0) < (row.playlistIndex ?? 0)).length;
}

/**
 * What a track's menu acts on: the selection, in the order it plays, when
 * the track is in it; else the track alone.
 */
export function menuTargets(trackId: string): string[] {
  const root = current();
  if (!root || !root.selectedTrackIds.includes(trackId)) {
    return [trackId];
  }
  const chosen = new Set(root.selectedTrackIds);
  return orderDetailPlaylist(root.tracks.filter((track) => chosen.has(track.id))).map((track) => track.id);
}

/** How many tracks a track's menu acts on (see menuTargets). */
export function menuTargetCount(trackId: string): number {
  const root = current();
  return root?.selectedTrackIds.includes(trackId) ? root.selectedTrackIds.length : 1;
}

function queue(tracks: Track[], label: string, where: "next" | "end"): void {
  const root = current();
  if (!root || tracks.length === 0) {
    return;
  }
  const items = tracks.map((track) => ({ rootId: root.id, trackId: track.id }));
  if (where === "next") {
    playNext(items, label);
    showToast(tn("message.playNext", items.length, { title: label }));
  } else {
    addToQueue(items, label);
    showToast(tn("message.queued", items.length, { title: label }));
  }
}

/** Queues tracks of the active root (in the order they play), next or at the end. */
export function queueTracks(trackIds: readonly string[], where: "next" | "end"): void {
  const root = current();
  if (!root) {
    return;
  }
  const wanted = new Set(trackIds);
  const tracks = orderDetailPlaylist(root.tracks.filter((track) => wanted.has(track.id)));
  const label = tracks.length === 1 ? tracks[0].metadata.title || tracks[0].name : tn("tracks.count", tracks.length);
  queue(tracks, label, where);
}

/** A folder row's (or a view's group's) tracks, in the order they play, and its name. */
export function folderTracks(rowKey: string): { label: string; trackIds: string[] } | null {
  const { root, rows } = derive();
  const row = rows.find((item) => item.key === rowKey);
  if (!root || !row || row.kind !== "album") {
    return null;
  }
  const scope = detailScope({ ...root, activeRowKey: rowKey }, rows);
  return { label: scope.label, trackIds: playOrder(scope).map((track) => track.id) };
}

/** Queues a folder row's tracks, in the order the folder plays them, next or at the end. */
/**
 * What the album sheet shows, queued in the order it plays, its first track loaded paused (nothing
 * starts by itself): the app embedded in the landing page, ready for its play keys.
 */
export function queueWhatIsShown(): void {
  const { root, scope } = derive();
  if (!root || scope.tracks.length === 0) return;
  addToQueue(queueOf(root.id, playOrder(scope).map((track) => track.id), scope.label).items, scope.label);
}

export function queueFolder(rowKey: string, where: "next" | "end"): void {
  const { root, rows } = derive();
  const row = rows.find((item) => item.key === rowKey);
  if (!root || !row || row.kind !== "album") {
    return;
  }
  const scope = detailScope({ ...root, activeRowKey: rowKey }, rows);
  queue(playOrder(scope), scope.label, where);
}

/**
 * Shows a track in the library: its root active, the rows above it open in the root's view (its
 * folders in Files; its artist, album or both in the others), and it the current row; then the
 * list scrolls to it (`ui.revealed`). A view with no row of it (Playlists) gives way to Files.
 * The selection stays as it is. On a phone the library comes into view; with `details`, Details
 * does instead (its group's or folder's songs), scrolled to the track (`ui.shownTrack`), and the
 * rows above it are the only ones open of their levels (a phone's way back goes up through them).
 */
export function revealTrack(rootId: string, trackId: string, details = false): void {
  library.activeRootId = rootId;
  updateRoots((roots) =>
    roots.map((root) => {
      const track = root.id === rootId ? root.tracks.find((item) => item.id === trackId) : undefined;
      if (!track) return root;
      const view = root.view ?? "files";
      const place = view === "files" ? null : trackPlace(buildViewRows(view, root.tracks, "all", viewLabels(), root.playlists ?? []), trackId);
      const files = view === "files" || !place;
      const open = files ? collectFolderPaths([track]) : place.open;
      // With `details`, the view's other folders or groups close (another view's stay as they are).
      const shown = !details ? null : new Set(files ? collectFolderPaths(root.tracks) : buildViewRows(view, root.tracks, "all", viewLabels(), root.playlists ?? []).filter((row) => row.kind === "album").map((row) => row.album));
      const expanded = shown ? root.expandedAlbums.filter((key) => !shown.has(key)) : root.expandedAlbums;
      return { ...root, view: files ? "files" : view, expandedAlbums: [...new Set([...expanded, ...open])], activeRowKey: `track:${track.id}` };
    })
  );
  ui.pane = details ? "details" : "library";
  ui.revealed += 1;
  if (details) {
    ui.shownTrack = trackId;
    ui.shown += 1;
  }
}

/** Shows the track playing in the library (the faceplate's key); nothing when none plays. */
export function revealPlaying(): void {
  const playing = $toRaw(nowPlaying.value);
  if (playing) revealTrack(playing.rootId, playing.trackId);
}
