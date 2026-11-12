// The rows' menus (the ⋮ key): what a track's, a folder's (or a view's
// group's), a playlist's and a playlist entry's menu offers, and doing it.
// The library's tree and the album sheet use the same ones.
// See RECORD/2026-11-04.github-actions-workflows.WIP.md (22:00 and 23:32, W4;
// W8's plan for the playlists' items).

import type { WizardTreeRow } from "../types";
import { can } from "./account";
import { openSelectionFor } from "./editor";
import { isFavourite, toggleFavourite } from "./mine";
import { t, tn } from "./i18n";
import { moveInPlaylist, openPlaylistDialog, removeFromPlaylist } from "./playlists";
import { showInLibrary } from "./roots";
import { ui } from "./ui";
import { activeRoot, folderTracks, goToGroup, menuTargetCount, menuTargets, playFromTree, queueFolder, queueTracks, setCurrentRow } from "./workspace";

/** An item of a menu, as the theme's `Menu` takes it: its glyph, and the row it shares (`group`). */
export type MenuItem = { id: string; label: string; danger?: boolean; rule?: boolean; icon?: string; group?: string; disabled?: boolean };

/** The items' glyphs: SVG paths in a 16-unit box, drawn as strokes by the theme's `Menu`. */
const ICONS: Record<string, string> = {
  play: "M5 3v10l8-5z",
  next: "M2.5 4h7M2.5 8h7M2.5 12h4M10.5 9.5l3.5 2.25-3.5 2.25z",
  queue: "M2.5 4h11M2.5 8h11M2.5 12h6M12.25 10v4.5M10 12.25h4.5",
  playlist: "M6 12.5V3.5l6-1.5v3M4.5 14a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3M12.5 9v5M10 11.5h5",
  album: "M8 1.75a6.25 6.25 0 1 0 0 12.5 6.25 6.25 0 0 0 0-12.5zM8 7a1 1 0 1 0 0 2 1 1 0 0 0 0-2z",
  artist: "M8 2.75a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM3 14c.6-2.6 2.6-4 5-4s4.4 1.4 5 4",
  show: "M1.75 4.25v8.5h12.5v-7H7.5L6 4.25z",
  favourite: "M8 2l1.8 3.8 4.2.5-3.1 2.9.8 4.1L8 11.3l-3.7 2 .8-4.1L2 6.3l4.2-.5z",
  edit: "M9.6 2.9 13.1 6.4 5.85 13.65H2.35v-3.5L9.6 2.9zM8.35 4.15l3.5 3.5",
  info: "M8 1.75a6.25 6.25 0 1 0 0 12.5 6.25 6.25 0 0 0 0-12.5zM8 7.25v4M8 4.75v.01",
  rename: "M2.5 5.5h7v5h-7zM12 3v10M10.5 3h3M10.5 13h3",
  remove: "M2.5 4.5h11M6 4.5V2.75h4V4.5M4 4.5l.75 9h6.5l.75-9",
  details: "M3.5 1.75h9v12.5h-9zM5.75 5.25h4.5M5.75 8h4.5M5.75 10.75h3",
  delete: "M2.5 4.5h11M6 4.5V2.75h4V4.5M4 4.5l.75 9h6.5l.75-9",
  up: "M8 13V3M4 7l4-4 4 4",
  down: "M8 3v10M4 9l4 4 4-4",
  out: "M2.5 4h11M2.5 8h11M2.5 12h5M10 12.25h4.5"
};

/** Pairs that share a row, side by side. */
const GROUPS: Record<string, string> = { next: "queue", queue: "queue", album: "go", artist: "go", info: "file", rename: "file", up: "move", down: "move" };

/** The items with their glyphs and rows. */
function styled(items: MenuItem[]): MenuItem[] {
  return items.map((item) => ({ ...item, icon: ICONS[item.id], group: GROUPS[item.id] }));
}

/** The items that change the folders: only for editors and up (S3); a listener's menus leave them out. */
const CHANGES = new Set(["playlist", "edit", "rename", "remove", "delete", "up", "down", "out"]);
/** In the family library, anyone edits their own version and keeps their own playlists (F3). */
const LIBRARY_CHANGES = new Set(["rename", "remove"]);

function allowed(items: MenuItem[]): MenuItem[] {
  if (can("editor")) return styled(items);
  const changes = activeRoot.value.data?.source.kind === "library" ? LIBRARY_CHANGES : CHANGES;
  return styled(items.filter((item) => !changes.has(item.id)));
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
  // The family library: one's favourites (F3).
  const root = activeRoot.value.data;
  const track = root?.source.kind === "library" ? root.tracks.find((one) => one.id === trackId) : undefined;
  if (track) {
    items.push({ id: "favourite", label: isFavourite(track.relativePath) ? t("menu.unfavourite") : t("menu.favourite") });
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
    case "favourite": {
      const track = activeRoot.value.data?.tracks.find((one) => one.id === trackId);
      if (track) void toggleFavourite(track.relativePath);
      break;
    }
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
    return styled(entry.map((item, at) => (at === 0 ? { ...item, rule: false } : item)));
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
