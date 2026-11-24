// What covers an Android phone's screen edges (the status bar, the selfie camera's cutout, the
// navigation bar): Android 15 draws apps edge to edge, under them. The app's plugin reads them from
// the system and says them in CSS pixels; they become `--mm-safe-top`, `-right`, `-bottom` and
// `-left` on the page's root, which the views keep clear of (their fallback is the browser's own
// `env(safe-area-inset-*)`). See RECORD/2026-08-11.musikmatch-rust-migration.WIP.md (2026-11-12).
// The keyboard too: the webview keeps its size and the keyboard lies over it, so the plugin says how
// much it covers, which becomes `--mm-keyboard` (lib/keyboard.ts does it in a browser). See
// RECORD/2026-11-03.deck-design-system.WIP.md (2026-11-14). The app's own page shrinks above it
// too (`--mm-app-keyboard`, views/app.html), as Chrome's does by itself (`interactive-widget`), and
// a field taking the focus is brought into view once it is up: a field low on the welcome page (a
// server's email) was left under it.

import { addPluginListener, invoke } from "@tauri-apps/api/core";

type Edges = { top: number; right: number; bottom: number; left: number; keyboard?: number };

const PLUGIN = "jackbird-player";

function apply(edges: Edges): void {
  const root = document.documentElement.style;
  // Device pixels, as the system gives them: the one size here that is not in rem.
  for (const side of ["top", "right", "bottom", "left"] as const) root.setProperty(`--mm-safe-${side}`, `${edges[side]}px`);
  const keyboard = `${Math.max(0, edges.keyboard ?? 0)}px`;
  root.setProperty("--mm-keyboard", keyboard);
  root.setProperty("--mm-app-keyboard", keyboard);
  document.dispatchEvent(new Event("mm-keyboard"));
}

/** A field taking the focus, brought into view once the keyboard is up (or a moment after). */
function reveal(event: FocusEvent): void {
  const field = event.target as HTMLElement | null;
  if (!field?.matches?.("input, textarea, select, [contenteditable]")) return;
  const show = () => {
    document.removeEventListener("mm-keyboard", show);
    if (document.activeElement === field) field.scrollIntoView({ block: "nearest" });
  };
  document.addEventListener("mm-keyboard", show);
  window.setTimeout(show, 400);
}

/** Keeps the page clear of what covers the screen's edges, from now on. */
export function keepClearOfEdges(): void {
  void invoke<Edges>(`plugin:${PLUGIN}|safe_area`).then(apply, () => undefined);
  void addPluginListener<Edges>(PLUGIN, "insets", apply).catch(() => undefined);
  document.addEventListener("focusin", reveal);
}
