// The library: the open folders (roots) and the state around them. Its
// handlers still live in the React view; they move here as the screens
// become jq79 views (ROADMAP/2026-11-03/deck-design-system.md).

import { $reactive } from "jq79";
import type { RootWorkspace } from "../types";

export const library = $reactive({
  roots: [] as RootWorkspace[],
  activeRootId: null as string | null,
  loading: false,
  saving: false,
  restoring: true,
  errorMessage: null as string | null,
  infoMessage: null as string | null
});
