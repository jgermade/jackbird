// Which dialogs are open: the preferences, the queue's, and the selection's
// dialog with the tab it shows (see the files' info, edit their tags, rename
// them, or remove them from the library); and on phones, which panel is in view (the
// workspace scrolls to it, and sets it when a swipe ends).

import { $reactive } from "jq79";

export type SelectionTab = "info" | "edit" | "rename" | "danger";
export type Pane = "library" | "details";

export const ui = $reactive({
  preferencesOpen: false,
  queueOpen: false,
  selectionOpen: false,
  selectionTab: "edit" as SelectionTab,
  pane: "library" as Pane
});
