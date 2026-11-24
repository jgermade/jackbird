/**
 * Which of the library's views have their key in its head (Settings, Library): every one but
 * Artists unless chosen otherwise (the owner, 2026-11-24), and never none. Kept as their names,
 * comma-separated. See RECORD/2026-11-03.deck-design-system.WIP.md (2026-11-24, "The views shown").
 */

import type { LibraryView } from "../types.ts";

/** The views, in the order their keys stand. */
export const VIEW_ORDER: readonly LibraryView[] = ["files", "playlists", "artists", "albumsByArtist", "albums", "compilations"];

/** The views shown when none were chosen. */
export const DEFAULT_SHOWN: readonly LibraryView[] = VIEW_ORDER.filter((view) => view !== "artists");

/** The views shown, from what was kept: the known ones, in their order; the default when none. */
export function shownViewsOf(raw: string | null | undefined): LibraryView[] {
  if (raw === null || raw === undefined) return [...DEFAULT_SHOWN];
  const kept = new Set(raw.split(",").map((name) => name.trim()));
  const shown = VIEW_ORDER.filter((view) => kept.has(view));
  return shown.length > 0 ? shown : [...DEFAULT_SHOWN];
}

/** The views shown once `view` is turned on or off; the last one shown stays. */
export function toggledView(shown: readonly LibraryView[], view: LibraryView, on: boolean): LibraryView[] {
  const next = VIEW_ORDER.filter((one) => (one === view ? on : shown.includes(one)));
  return next.length > 0 ? next : [...shown];
}

/** The view to list a root in: its own if shown, else the first shown. */
export function viewShown(view: LibraryView, shown: readonly LibraryView[]): LibraryView {
  return shown.includes(view) ? view : (shown[0] ?? view);
}
