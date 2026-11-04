// Which dialogs are open: the preferences, and the selection's dialog with
// the tab it shows (edit the tags, see the files' info, or remove them from
// the library).

import { $reactive } from "jq79";

export type SelectionTab = "edit" | "info" | "danger";

export const ui = $reactive({
  preferencesOpen: false,
  selectionOpen: false,
  selectionTab: "edit" as SelectionTab
});
