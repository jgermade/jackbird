// What covers an Android phone's screen edges (the status bar, the selfie camera's cutout, the
// navigation bar): Android 15 draws apps edge to edge, under them. The app's plugin reads them from
// the system and says them in CSS pixels; they become `--mm-safe-top`, `-right`, `-bottom` and
// `-left` on the page's root, which the views keep clear of (their fallback is the browser's own
// `env(safe-area-inset-*)`). See RECORD/2026-08-11.musikmatch-rust-migration.WIP.md (2026-11-12).

import { addPluginListener, invoke } from "@tauri-apps/api/core";

type Edges = { top: number; right: number; bottom: number; left: number };

const PLUGIN = "jackbird-player";

function apply(edges: Edges): void {
  const root = document.documentElement.style;
  // Device pixels, as the system gives them: the one size here that is not in rem.
  for (const side of ["top", "right", "bottom", "left"] as const) root.setProperty(`--mm-safe-${side}`, `${edges[side]}px`);
}

/** Keeps the page clear of what covers the screen's edges, from now on. */
export function keepClearOfEdges(): void {
  void invoke<Edges>(`plugin:${PLUGIN}|safe_area`).then(apply, () => undefined);
  void addPluginListener<Edges>(PLUGIN, "insets", apply).catch(() => undefined);
}
