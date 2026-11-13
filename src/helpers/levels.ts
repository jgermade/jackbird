/**
 * A phone's list of the library: no nesting. The folders (or a view's groups) that are open are
 * listed first, from the top one down, one per level, and under them only what the last of them
 * holds. Entering a folder opens it alone at its level; leaving an open one closes it and the ones
 * under it. Worked out from the tree's own rows (helpers/tree.ts, helpers/views.ts) and the root's
 * open folders, so a computer's tree and a phone's levels are the same state. See
 * RECORD/2026-11-03.deck-design-system.WIP.md (2026-11-12 19:00 UTC).
 */

import type { WizardTreeRow } from "../types.ts";

export type Levels = {
  /** The open folders, from the top one down: one per level. */
  open: WizardTreeRow[];
  /** What the last of them holds; with none open, the list's top level. */
  rows: WizardTreeRow[];
};

const isFolder = (row: WizardTreeRow): boolean => row.kind === "album";

/** The levels of the tree's visible `rows`: at each level the first open folder is the one followed. */
export function levelsOf(rows: readonly WizardTreeRow[]): Levels {
  const open: WizardTreeRow[] = [];
  let parent: string | null = null;
  for (;;) {
    const next = rows.find((row) => row.parentKey === parent && isFolder(row) && row.expanded);
    if (!next) break;
    open.push(next);
    parent = next.key;
  }
  return { open, rows: rows.filter((row) => row.parentKey === parent) };
}

/** The folders from the top down to the row `rowKey` (itself last, if it is a folder), as what opens them. */
function pathTo(rows: readonly WizardTreeRow[], rowKey: string): string[] {
  const byKey = new Map(rows.map((row) => [row.key, row]));
  const path: string[] = [];
  for (let row = byKey.get(rowKey); row; row = row.parentKey ? byKey.get(row.parentKey) : undefined) {
    if (isFolder(row)) path.unshift(row.album);
  }
  return path;
}

/**
 * `expanded` with, of the folders in `rows`, only `keep` open: the ones the list does not show
 * (another view's groups, kept in the same list) stay as they are.
 */
function onlyOpen(rows: readonly WizardTreeRow[], expanded: readonly string[], keep: readonly string[]): string[] {
  const shown = new Set(rows.filter(isFolder).map((row) => row.album));
  const kept = new Set(keep);
  return [...expanded.filter((key) => !shown.has(key) || kept.has(key)), ...keep.filter((key) => !expanded.includes(key))];
}

/** The open folders once the folder of row `rowKey` is entered: it and the ones above it, no other shown. */
export function openOnEntering(rows: readonly WizardTreeRow[], expanded: readonly string[], rowKey: string): string[] {
  return onlyOpen(rows, expanded, pathTo(rows, rowKey));
}

/** The open folders once the open folder of row `rowKey` is left: the ones above it, no other shown. */
export function openOnLeaving(rows: readonly WizardTreeRow[], expanded: readonly string[], rowKey: string): string[] {
  return onlyOpen(rows, expanded, pathTo(rows, rowKey).slice(0, -1));
}
