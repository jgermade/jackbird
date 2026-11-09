// The rows' menus (the ⋮ key): what a track's, a folder's (or a view's
// group's), a playlist's and a playlist entry's menu offers, and doing it.
// The library's tree and the album sheet use the same ones.
// See RECORD/2026-11-04.github-actions-workflows.WIP.md (22:00 and 23:32, W4;
// W8's plan for the playlists' items).

import type { WizardTreeRow } from "../types";
import { can } from "./account";
import { openSelectionFor } from "./editor";
import { t, tn } from "./i18n";
import { moveInPlaylist, openPlaylistDialog, removeFromPlaylist } from "./playlists";
import { showInLibrary } from "./roots";
import { ui } from "./ui";
import { activeRoot, folderTracks, goToGroup, menuTargetCount, menuTargets, playFromTree, queueFolder, queueTracks, setCurrentRow } from "./workspace";

/** An item of a menu, as the theme's `Menu` takes it. */
export type MenuItem = { id: string; label: string; danger?: boolean; rule?: boolean };

/** The items that change the folders: only for editors and up (S3); a listener's menus leave them out. */
const CHANGES = new Set(["playlist", "edit", "rename", "remove", "delete", "up", "down", "out"]);

function allowed(items: MenuItem[]): MenuItem[] {
  return can("editor") ? items : items.filter((item) => !CHANGES.has(item.id));
}

/** Where a track's menu is: the tree, or the album sheet (which adds "Show in library"). */
export type TrackMenuPlace = "tree" | "sheet";

/** A track's menu; with the selection when the track is in it (the labels say how many). */
export function trackMenu(trackId: string, place: TrackMenuPlace): MenuItem[] {
  const count = menuTargetCount(trackId);
  const items: MenuItem[] = [
    { id: "next", label: tn("menu.playNext", count) },
    { id: "queue", label: tn("menu.addToQueue", count) },
    { id: "playlist", label: tn("menu.addToPlaylist", count) },
    { id: "album", label: t("menu.goToAlbum"), rule: true },
    { id: "artist", label: t("menu.goToArtist") }
  ];
  if (place === "sheet") {
    items.push({ id: "show", label: t("menu.showInLibrary") });
  }
  items.push(
    { id: "edit", label: t("menu.edit"), rule: true },
    { id: "info", label: t("menu.info") },
    { id: "rename", label: tn("menu.rename", count) },
    { id: "remove", label: tn("menu.remove", count), danger: true, rule: true }
  );
  return allowed(items);
}

/** Asks which playlist to add tracks of the active root to. */
function askPlaylist(trackIds: string[], label: string): void {
  const root = activeRoot.value.data;
  if (root && trackIds.length > 0) {
    openPlaylistDialog({ mode: "add", rootId: root.id, trackIds, label });
  }
}

/** Does what a track's menu item says. */
export function onTrackMenu(trackId: string, choice: string): void {
  switch (choice) {
    case "next":
    case "queue":
      queueTracks(menuTargets(trackId), choice === "next" ? "next" : "end");
      break;
    case "playlist": {
      const targets = menuTargets(trackId);
      const track = activeRoot.value.data?.tracks.find((item) => item.id === trackId);
      askPlaylist(targets, targets.length === 1 && track ? track.metadata.title || track.name : tn("tracks.count", targets.length));
      break;
    }
    case "album":
    case "artist":
      goToGroup(trackId, choice);
      ui.pane = "details";
      break;
    case "show": {
      const root = activeRoot.value.data;
      if (root) {
        showInLibrary(root.id, trackId);
        ui.pane = "library";
      }
      break;
    }
    case "edit":
      openSelectionFor(trackId, "edit");
      break;
    case "info":
      openSelectionFor(trackId, "info");
      break;
    case "rename":
      openSelectionFor(trackId, "rename");
      break;
    case "remove":
      openSelectionFor(trackId, "danger");
      break;
  }
}

/** A folder's (or a view's group's) menu; a playlist's offers deleting it rather than adding it to one. */
export function folderMenu(playlist = false): MenuItem[] {
  const items: MenuItem[] = [
    { id: "play", label: t("menu.play") },
    { id: "next", label: tn("menu.playNext", 1) },
    { id: "queue", label: tn("menu.addToQueue", 1) }
  ];
  if (!playlist) {
    items.push({ id: "playlist", label: tn("menu.addToPlaylist", 1) });
  }
  items.push({ id: "details", label: t("menu.openInDetails"), rule: true });
  if (playlist) {
    items.push({ id: "delete", label: t("menu.deletePlaylist"), danger: true, rule: true });
  }
  return allowed(items);
}

/** Does what a folder's menu item says. */
export function onFolderMenu(rowKey: string, choice: string): void {
  switch (choice) {
    case "play":
      setCurrentRow(rowKey);
      playFromTree(rowKey);
      break;
    case "next":
    case "queue":
      queueFolder(rowKey, choice === "next" ? "next" : "end");
      break;
    case "playlist": {
      const found = folderTracks(rowKey);
      if (found) {
        askPlaylist(found.trackIds, found.label);
      }
      break;
    }
    case "details":
      setCurrentRow(rowKey);
      ui.pane = "details";
      break;
  }
}

/** The extra items of a playlist entry's menu: move it, take it out. */
function entryItems(row: WizardTreeRow, count: number): MenuItem[] {
  const index = row.playlistIndex ?? 0;
  const items: MenuItem[] = [];
  if (index > 0) items.push({ id: "up", label: t("menu.moveUp") });
  if (index < count - 1) items.push({ id: "down", label: t("menu.moveDown") });
  items.push({ id: "out", label: t("menu.removeFromPlaylist"), danger: true });
  items[0].rule = true;
  return items;
}

/** How many entries the playlist of a row has. */
function entryCount(row: WizardTreeRow): number {
  return activeRoot.value.data?.playlists.find((playlist) => playlist.path === row.playlist)?.entries.length ?? 0;
}

/** A tree row's menu: a track's, a folder's or group's, a playlist's, or a playlist entry's (found or missing). */
export function rowMenu(row: WizardTreeRow): MenuItem[] {
  if (row.kind === "album") {
    return allowed(folderMenu(!!row.playlist));
  }
  const entry = row.playlist !== undefined && row.playlistIndex !== undefined ? entryItems(row, entryCount(row)) : [];
  if (!row.trackId) {
    return entry.map((item, at) => (at === 0 ? { ...item, rule: false } : item));
  }
  const items = trackMenu(row.trackId, "tree");
  if (entry.length === 0) {
    return allowed(items);
  }
  // The entry's own items go before the track's danger zone.
  const danger = items.findIndex((item) => item.danger);
  return allowed([...items.slice(0, danger), ...entry, ...items.slice(danger)]);
}

/** Does what a tree row's menu item says. */
export function onRowMenu(row: WizardTreeRow, choice: string): void {
  const root = activeRoot.value.data;
  if (row.kind === "album") {
    if (choice === "delete" && root && row.playlist) {
      openPlaylistDialog({ mode: "delete", rootId: root.id, path: row.playlist, name: row.label });
    } else {
      onFolderMenu(row.key, choice);
    }
    return;
  }
  if (root && row.playlist !== undefined && row.playlistIndex !== undefined && (choice === "up" || choice === "down" || choice === "out")) {
    const index = row.playlistIndex;
    if (choice === "out") {
      void removeFromPlaylist(root.id, row.playlist, index);
    } else {
      const to = choice === "up" ? index - 1 : index + 1;
      // The current row moves with the entry.
      void moveInPlaylist(root.id, row.playlist, index, to);
      setCurrentRow(`@pl:${row.playlist}#${to}`);
    }
    return;
  }
  if (row.trackId) {
    onTrackMenu(row.trackId, choice);
  }
}
