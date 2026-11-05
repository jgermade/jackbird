// The rows' menus (the ⋮ key): what a track's or a folder's menu offers, and
// doing it. The library's tree and the album sheet use the same ones. "Go to
// album" and "Go to artist" join with W6's views.
// See RECORD/2026-11-04.github-actions-workflows.WIP.md (22:00 and 23:32, W4).

import { openSelectionFor } from "./editor";
import { t, tn } from "./i18n";
import { showInLibrary } from "./roots";
import { ui } from "./ui";
import { activeRoot, menuTargetCount, menuTargets, playFromTree, queueFolder, queueTracks, setCurrentRow } from "./workspace";

/** An item of a menu, as the theme's `Menu` takes it. */
export type MenuItem = { id: string; label: string; danger?: boolean; rule?: boolean };

/** Where a track's menu is: the tree, or the album sheet (which adds "Show in library"). */
export type TrackMenuPlace = "tree" | "sheet";

/** A track's menu; with the selection when the track is in it (the labels say how many). */
export function trackMenu(trackId: string, place: TrackMenuPlace): MenuItem[] {
  const count = menuTargetCount(trackId);
  const items: MenuItem[] = [
    { id: "next", label: tn("menu.playNext", count) },
    { id: "queue", label: tn("menu.addToQueue", count) }
  ];
  if (place === "sheet") {
    items.push({ id: "show", label: t("menu.showInLibrary"), rule: true });
  }
  items.push(
    { id: "edit", label: t("menu.edit"), rule: true },
    { id: "info", label: t("menu.info") },
    { id: "rename", label: tn("menu.rename", count) },
    { id: "remove", label: tn("menu.remove", count), danger: true, rule: true }
  );
  return items;
}

/** Does what a track's menu item says. */
export function onTrackMenu(trackId: string, choice: string): void {
  switch (choice) {
    case "next":
    case "queue":
      queueTracks(menuTargets(trackId), choice === "next" ? "next" : "end");
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

/** A folder's menu. */
export function folderMenu(): MenuItem[] {
  return [
    { id: "play", label: t("menu.play") },
    { id: "next", label: tn("menu.playNext", 1) },
    { id: "queue", label: tn("menu.addToQueue", 1) },
    { id: "details", label: t("menu.openInDetails"), rule: true }
  ];
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
    case "details":
      setCurrentRow(rowKey);
      ui.pane = "details";
      break;
  }
}
