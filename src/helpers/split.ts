/**
 * The split between the library pane and the album sheet on wider screens (the workspace), in
 * rem: the library's width, which the person drags, kept within the room the window gives. See
 * RECORD/2026-11-03.deck-design-system.WIP.md (2026-11-13 01:10).
 */

/**
 * The library's width when none was chosen, and in the landing page's window (`embed`, the app
 * embedded: chosen nowhere, kept nowhere); and the least each pane keeps.
 */
export const SPLIT = { initial: 23.75, embed: 19, minLibrary: 16, minSheet: 20 } as const;

/**
 * The library's width within the panes' (`total`, both in rem): at least `minLibrary`, leaving the
 * sheet at least `minSheet`. When the panes are too narrow for both, the library keeps its least.
 */
export function clampSplit(width: number, total: number): number {
  const most = Math.max(SPLIT.minLibrary, total - SPLIT.minSheet);
  const wanted = Number.isFinite(width) ? width : SPLIT.initial;
  return Math.min(most, Math.max(SPLIT.minLibrary, wanted));
}

/** A width read back from storage: a number of rem, or null for anything else (none chosen). */
export function parseSplit(value: string | null): number | null {
  if (value === null || value.trim() === "") return null;
  const width = Number(value);
  return Number.isFinite(width) && width > 0 ? width : null;
}

/** Where a key moves the split from `width` (rem), or null for a key that does not move it. */
export function splitByKey(key: string, width: number, total: number): number | null {
  if (key === "ArrowLeft") return clampSplit(width - 1, total);
  if (key === "ArrowRight") return clampSplit(width + 1, total);
  if (key === "Home") return clampSplit(SPLIT.minLibrary, total);
  if (key === "End") return clampSplit(total, total);
  return null;
}
