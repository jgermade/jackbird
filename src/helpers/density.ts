// How tall the lists' rows are: compact (the rows as they were first drawn), comfortable (the
// default) or spacious. The tokens in theme/default/tokens.css draw them; the lists drawn a window
// at a time (jq79's `:window`: the songs view, the queue) need the heights as numbers, in rem, and
// read them here. See RECORD/2026-11-03.deck-design-system.WIP.md (2026-11-13).

import type { Density } from "../types.ts";

export const DENSITIES: readonly Density[] = ["compact", "comfortable", "spacious"];

export const DEFAULT_DENSITY: Density = "comfortable";

/** A row's height in rem: a tree row (one line), a songs view row (title and artist), a queue row. */
export type RowHeights = { row: number; song: number; queue: number };

const HEIGHTS: Record<Density, RowHeights> = {
  compact: { row: 1.75, song: 2.25, queue: 3.5 },
  comfortable: { row: 2.25, song: 2.75, queue: 3.5 },
  spacious: { row: 2.75, song: 3.25, queue: 4 }
};

/** The density a saved value names, else the default. */
export function densityOf(value: unknown): Density {
  return DENSITIES.find((density) => density === value) ?? DEFAULT_DENSITY;
}

/** The rows' heights at a density, in rem. */
export function rowHeights(density: Density): RowHeights {
  return HEIGHTS[density] ?? HEIGHTS[DEFAULT_DENSITY];
}
