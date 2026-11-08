// The active root: what the library shows of it (the tree, the album sheet's
// scope, the selection) and what can be done in it. The computed values read
// plain objects and wake when `library.roots` or `library.activeRootId` is
// replaced, which is how every write reaches them (see updateRoots). The
// actions write the library store; the views read it.

import { $computed, $toRaw } from "jq79";
import { groupAlbums, type AlbumGroup } from "../helpers/albums";
import { queueOf } from "../helpers/queue";
import { detailScope, type Scope } from "../helpers/scope";
import { nextSelection, selectMany } from "../helpers/selection";
import { orderDetailPlaylist } from "../helpers/tracks";
import { buildWizardRows, treeKeyAction } from "../helpers/tree";
import { albumKey, artistKey, buildViewRows, type ViewLabels } from "../helpers/views";
import type { LibraryView, Track, RootWorkspace, WizardTreeRow } from "../types";
import { t, tn } from "./i18n";
import { library } from "./library";
import { addToQueue, dropFromQueue, nowPlaying, playNext, playQueue, togglePlay } from "./player";
import { preferences } from "./preferences";
import { updateRoots } from "./roots";

import { Opaque } from "./opaque";

export { Opaque };

type Derived = {
  root: RootWorkspace | null;
  rows: WizardTreeRow[];
  scope: Scope;
};

// The last derivation, keyed on the roots array, the active id and the
// language (the views' labels): every write replaces the array (updateRoots),
// so identity is enough.
let cache: { roots: RootWorkspace[]; id: string | null; language: string; derived: Derived } | null = null;

/** The words the views need, in the interface's language. */
function viewLabels(): ViewLabels {
  return {
    unknownArtist: t("album.unknownArtist"),
    unknownAlbum: t("album.untitled"),
    variousArtists: t("views.variousArtists"),
    missing: t("playlist.missing"),
    locale: preferences.language
  };
}

/** A root's rows in its view: its folders (Files), or the view's groups. */
function rowsOf(root: RootWorkspace): WizardTreeRow[] {
  const view = root.view ?? "files";
  return view === "files"
    ? buildWizardRows(root.tracks, root.expandedAlbums)
    : buildViewRows(view, root.tracks, root.expandedAlbums, viewLabels(), root.playlists ?? []);
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
  if (cache && cache.roots === roots && cache.id === id && cache.language === language) {
    return cache.derived;
  }
  const root = roots.find((item) => item.id === id) ?? null;
  const rows = root ? rowsOf(root) : [];
  const derived = { root, rows, scope: detailScope(root, rows) };
  cache = { roots, id, language, derived };
  return derived;
}

export const activeRoot = $computed((): Opaque<RootWorkspace | null> => new Opaque(derive().root));

/** The tree's visible rows, in order. */
export const treeRows = $computed((): Opaque<WizardTreeRow[]> => new Opaque(derive().rows));

/** What the album sheet shows. */
export const detail = $computed((): Opaque<Scope> => new Opaque(derive().scope));

/** The sheet's tracks as albums and discs, titled in the current language. */
export const detailAlbums = $computed(
  (): Opaque<AlbumGroup[]> => new Opaque(groupAlbums(derive().scope.tracks, t("album.untitled"), preferences.language))
);

export const selectedTracks = $computed((): Opaque<Track[]> => {
  const { root } = derive();
  if (!root || root.selectedTrackIds.length === 0) {
    return new Opaque([]);
  }
  const selected = new Set(root.selectedTrackIds);
  return new Opaque(root.tracks.filter((track) => selected.has(track.id)));
});

/** The active root as a plain object. */
function current(): RootWorkspace | null {
  return derive().root;
}

/** A scope's tracks in the order they play: a view's own, else by folder, disc and number. */
function playOrder(scope: Scope): Track[] {
  return scope.ordered ? scope.tracks : orderDetailPlaylist(scope.tracks);
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
export function navigateTree(key: string, shiftKey = false): boolean {
  const root = current();
  const rows = derive().rows;
  const action = treeKeyAction(rows, root?.activeRowKey ?? null, key, shiftKey);
  if (action && "toggle" in action) {
    toggleFolder(action.toggle);
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
  updateActive((root) => ({
    ...root,
    expandedAlbums: root.expandedAlbums.includes(folder)
      ? root.expandedAlbums.filter((value) => value !== folder)
      : [...root.expandedAlbums, folder]
  }));
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
  if (!root || root.selectedTrackIds.length === 0) {
    return;
  }
  const gone = new Set(root.selectedTrackIds);
  // They leave the queue first (if the one playing goes, the next one plays), then the library.
  dropFromQueue((item) => item.rootId === root.id && gone.has(item.trackId));
  updateActive((item) => ({ ...clearedSelection(item), tracks: item.tracks.filter((track) => !gone.has(track.id)) }));
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
    playQueue(queueOf(root.id, trackIds, scope.label), index);
  }
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
    playQueue(queueOf(root.id, trackIds, scope.label), index);
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
    library.infoMessage = tn("message.playNext", items.length, { title: label });
  } else {
    addToQueue(items, label);
    library.infoMessage = tn("message.queued", items.length, { title: label });
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
export function queueFolder(rowKey: string, where: "next" | "end"): void {
  const { root, rows } = derive();
  const row = rows.find((item) => item.key === rowKey);
  if (!root || !row || row.kind !== "album") {
    return;
  }
  const scope = detailScope({ ...root, activeRowKey: rowKey }, rows);
  queue(playOrder(scope), scope.label, where);
}

/** Makes a track the selection, unless it is in it already. */
export function selectUnlessChosen(trackId: string): void {
  const root = current();
  if (!root || root.selectedTrackIds.includes(trackId)) {
    return;
  }
  updateActive((item) => ({ ...item, selectedTrackId: trackId, selectedTrackIds: [trackId], selectionAnchorTrackId: trackId }));
}
