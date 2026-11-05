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
  queueOpen: false,
  selectionOpen: false,
  selectionTab: "edit" as SelectionTab,
  playlist: null as PlaylistDialog | null,
  pane: "library" as Pane
});
