// What covers an Android phone's screen edges (the status bar, the selfie camera's cutout, the
// navigation bar): Android 15 draws apps edge to edge, under them. The app's plugin reads them from
// the system and says them in CSS pixels; they become `--mm-safe-top`, `-right`, `-bottom` and
// `-left` on the page's root, which the views keep clear of (their fallback is the browser's own
// `env(safe-area-inset-*)`). See RECORD/2026-08-11.musikmatch-rust-migration.WIP.md (2026-11-12).
// The keyboard too: the webview keeps its size and the keyboard lies over it, so the plugin says how
// much it covers, which becomes `--mm-keyboard` (lib/keyboard.ts does it in a browser). See
// RECORD/2026-11-03.deck-design-system.WIP.md (2026-11-14). Here it is also `--mm-keyboard-under`:
// the app (views/app.html) is that much shorter, so it ends where the keyboard starts, as Chrome's
// page does; and the field being typed in is brought into view above it (2026-11-23).

import { addPluginListener, invoke } from "@tauri-apps/api/core";

type Edges = { top: number; right: number; bottom: number; left: number; keyboard?: number };

const PLUGIN = "jackbird-player";

function apply(edges: Edges): void {
  const root = document.documentElement.style;
  // Device pixels, as the system gives them: the one size here that is not in rem.
  for (const side of ["top", "right", "bottom", "left"] as const) root.setProperty(`--mm-safe-${side}`, `${edges[side]}px`);
  const keyboard = Math.max(0, edges.keyboard ?? 0);
  root.setProperty("--mm-keyboard", `${keyboard}px`);
  root.setProperty("--mm-keyboard-under", `${keyboard}px`);
  document.dispatchEvent(new Event("mm-keyboard"));
  // Once the app is laid out at its new height: the field typed in, in view in what scrolls it.
  if (keyboard > 0) requestAnimationFrame(() => requestAnimationFrame(showFocused));
}

function showFocused(): void {
  const field = document.activeElement;
  if (field instanceof HTMLElement && field.matches("input, textarea, select, [contenteditable]")) {
    field.scrollIntoView({ block: "nearest" });
  }
}

/** Keeps the page clear of what covers the screen's edges, from now on. */
export function keepClearOfEdges(): void {
  void invoke<Edges>(`plugin:${PLUGIN}|safe_area`).then(apply, () => undefined);
  void addPluginListener<Edges>(PLUGIN, "insets", apply).catch(() => undefined);
}
