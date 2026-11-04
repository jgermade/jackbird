// Which dialogs are open.

import { $reactive } from "jq79";

export const ui = $reactive({
  preferencesOpen: false,
  editModalOpen: false,
  infoModalOpen: false
});
