// The library: the open folders (roots) and the state around them. The
// actions that change it live beside it in lib/ (roots, workspace, editor,
// session, verifier); the views read it.

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
