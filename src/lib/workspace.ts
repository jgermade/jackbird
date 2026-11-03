// The active root: what the library shows of it (the tree, the album sheet's
// scope, the selection) and what can be done in it. The computed values read
// plain objects and wake when `library.roots` or `library.activeRootId` is
// replaced, which is how every write reaches them (see updateRoots). The
// actions write the library store; the views read it.

import { $computed, $toRaw } from "jq79";
import { groupAlbums, type AlbumGroup } from "../helpers/albums";
import { computeCommonMetadata, emptyMetadata } from "../helpers/metadata";
import { detailScope, type Scope } from "../helpers/scope";
import { nextSelection } from "../helpers/selection";
import { collectFolderPaths, orderDetailPlaylist } from "../helpers/tracks";
import { buildWizardRows, treeKeyAction } from "../helpers/tree";
import type { Mp3Track, RootWorkspace, WizardTreeRow } from "../types";
import { t, tn } from "./i18n";
import { library } from "./library";
import { nowPlaying, playQueue, togglePlay } from "./player";
import { preferences } from "./preferences";
import { updateRoots } from "./roots";
import { ui } from "./ui";

/**
 * A derived value handed to views whole. jq79 passes class instances through
 * untouched, so the store that holds one never wraps it or compares it field
 * by field; a new box is simply a new value. Views read `.value.data` in their
 * bindings and never copy it into a store variable.
 */
export class Opaque<T> {
  constructor(readonly data: T) {}
}

type Derived = {
  root: RootWorkspace | null;
  rows: WizardTreeRow[];
  scope: Scope;
};

// The last derivation, keyed on the roots array and the active id: every
// write replaces the array (updateRoots), so identity is enough.
let cache: { roots: RootWorkspace[]; id: string | null; derived: Derived } | null = null;

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
  if (cache && cache.roots === roots && cache.id === id) {
    return cache.derived;
  }
  const root = roots.find((item) => item.id === id) ?? null;
  const rows = root ? buildWizardRows(root.tracks, root.expandedAlbums) : [];
  const derived = { root, rows, scope: detailScope(root, rows) };
  cache = { roots, id, derived };
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

export const selectedTracks = $computed((): Opaque<Mp3Track[]> => {
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

function updateActive(update: (root: RootWorkspace) => RootWorkspace): void {
  const id = $toRaw(library).activeRootId;
  if (id) {
    updateRoots((roots) => roots.map((root) => (root.id === id ? update(root) : root)));
  }
}

function clearedSelection(root: RootWorkspace): RootWorkspace {
  return { ...root, selectedTrackId: null, selectedTrackIds: [], selectionAnchorTrackId: null, draft: emptyMetadata() };
}

/**
 * A click on a track: `toggle` (plain) adds or removes it, `range` (Shift)
 * selects from the anchor to it, in the tree's order. It becomes the active
 * row, and a single selection becomes the draft.
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
    const single = selected.length === 1;
    const activeTrackId = single ? selected[0] : trackId;
    return {
      ...item,
      selectedTrackId: single ? activeTrackId : null,
      selectedTrackIds: [...selected],
      selectionAnchorTrackId: anchor,
      activeRowKey: `track:${activeTrackId}`,
      draft: single ? item.tracks.find((one) => one.id === activeTrackId)?.metadata ?? emptyMetadata() : emptyMetadata()
    };
  });
  library.infoMessage = null;
  library.errorMessage = null;
}

/** Makes a tree row the active one: a folder scopes the album sheet, a track is selected alone. */
export function selectTreeRow(rowKey: string): void {
  updateActive((root) => ({ ...clearedSelection(root), activeRowKey: rowKey }));
  const row = derive().rows.find((item) => item.key === rowKey);
  if (row?.kind === "track" && row.trackId) {
    selectTrack(row.trackId);
  }
}

/** An arrow key on the tree. True when the tree took it, so the view can stop the page scrolling. */
export function navigateTree(key: string): boolean {
  const root = current();
  const rows = derive().rows;
  const action = treeKeyAction(rows, root?.activeRowKey ?? null, key);
  if (action && "toggle" in action) {
    toggleFolder(action.toggle);
  } else if (action) {
    selectTreeRow(action.select);
  }
  return rows.length > 0 && key.startsWith("Arrow");
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

export function expandAllFolders(): void {
  updateActive((root) => ({ ...root, expandedAlbums: collectFolderPaths(root.tracks) }));
}

export function collapseAllFolders(): void {
  updateActive((root) => ({ ...root, expandedAlbums: [], expandedDiscs: [] }));
}

/** Drops the selected tracks from the library (not from disk). The view asks first. */
export function removeSelectedTracks(): void {
  const root = current();
  if (!root || root.selectedTrackIds.length === 0) {
    return;
  }
  const gone = new Set(root.selectedTrackIds);
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
  const trackIds = orderDetailPlaylist(scope.tracks).map((track) => track.id);
  const index = trackIds.indexOf(trackId);
  if (index !== -1) {
    playQueue({ rootId: root.id, trackIds, sourceLabel: scope.label }, index);
  }
}

/** The per-track rename key: a placeholder until the naming pattern exists. */
export function consolidateTrack(): void {
  library.infoMessage = t("message.consolidatePending");
}

/** Opens the editor on the selection, with the values the tracks share as the draft. */
export function openEditor(): void {
  const tracks = selectedTracks.value.data;
  if (tracks.length === 0) {
    return;
  }
  updateActive((root) => ({ ...root, draft: computeCommonMetadata(tracks) }));
  ui.editModalOpen = true;
}

export function showInfo(): void {
  if (selectedTracks.value.data.length > 0) {
    ui.infoModalOpen = true;
  }
}
