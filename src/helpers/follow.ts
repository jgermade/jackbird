/**
 * The tree following the current row on a computer: a click on a folder opens it, and the folders
 * opened that way (not by their caret) close again once the current row leaves them. See
 * RECORD/2026-11-03.deck-design-system.WIP.md (2026-11-13 17:15).
 */

export type Opened = { expanded: string[]; auto: string[] };

/**
 * The folders open after the current row moves to `folder` (a folder's key; null for a track),
 * whose folders above it are `ancestors`: the ones opened by a click that hold neither close, and
 * `folder` opens (counted as opened by a click) unless it was open already.
 */
export function followFolder(state: Opened, folder: string | null, ancestors: readonly string[]): Opened {
  const keep = new Set(ancestors);
  if (folder) keep.add(folder);
  const closing = new Set(state.auto.filter((key) => !keep.has(key)));
  let expanded = state.expanded.filter((key) => !closing.has(key));
  let auto = state.auto.filter((key) => !closing.has(key));
  if (folder && !expanded.includes(folder)) {
    expanded = [...expanded, folder];
    auto = [...auto, folder];
  }
  return { expanded, auto };
}

/** A folder opened or closed by its caret is the person's: it is no longer one a click opened. */
export function byCaret(auto: readonly string[], folder: string): string[] {
  return auto.filter((key) => key !== folder);
}

/**
 * Albums by artist keeps one artist open (the owner, 2026-11-25): of the groups at the top
 * (`tops`), only `keep` (the one holding the current row) stays among the folders open; the
 * albums under any of them keep their own state. With no `keep`, the top ones all close.
 */
export function oneTopOpen(expanded: readonly string[], tops: readonly string[], keep: string | null): string[] {
  const closing = new Set(tops.filter((key) => key !== keep));
  return expanded.filter((key) => !closing.has(key));
}
