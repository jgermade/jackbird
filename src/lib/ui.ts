// Which dialogs are open: the preferences, the queue's, the playlist dialog
// (and what for), and the selection's dialog with the tab it shows (see the
// files' info, edit their tags, rename them, or remove them from the
// library); and on phones, which panel is in view (the
// workspace scrolls to it, and sets it when a swipe ends).

import { $reactive } from "jq79";

export type SelectionTab = "info" | "edit" | "rename" | "danger";

/**
 * What the playlist dialog is doing: adding tracks of a root to one of its
 * playlists (or a new one), saving the queue as a playlist (`sub`: from the
 * queue's dialog, as a sheet of it), or asking before deleting one.
 */
export type PlaylistDialog =
  | { mode: "add"; rootId: string; trackIds: string[]; label: string }
  | { mode: "queue"; sub?: boolean }
  | { mode: "delete"; rootId: string; path: string; name: string };

export type Pane = "library" | "details";

export const ui = $reactive({
  preferencesOpen: false,
  /** The section open in the preferences (views/preferences-dialog.html); not saved. */
  preferencesSection: "general",
  queueOpen: false,
  selectionOpen: false,
  selectionTab: "edit" as SelectionTab,
  playlist: null as PlaylistDialog | null,
  pane: "library" as Pane,
  /** Bumped when a track is shown in the library (lib/workspace.ts `revealTrack`): the list scrolls to its row. */
  revealed: 0,
  /** The track shown in Details from the search (lib/workspace.ts `revealTrack`), and a count bumped each time: Details scrolls to its row. */
  shownTrack: null as string | null,
  shown: 0,
  /** The active root's duplicates dialog (views/duplicates-dialog.html). */
  duplicatesOpen: false,
  /** The track of the active root whose own info dialog is open (views/track-info-dialog.html), from its length in Details. */
  trackInfo: null as string | null,
  /** Asking whether a disc played replaces a queue holding tracks put there on purpose (views/replace-queue-dialog.html, lib/player.ts playTracks). */
  replaceQueue: false
});
