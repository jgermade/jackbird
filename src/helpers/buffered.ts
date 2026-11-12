/**
 * How far a streamed track is buffered: from the element's buffered ranges, the end of the one the
 * play position is in. See RECORD/2026-11-03.deck-design-system.WIP.md (2026-11-13 14:10).
 */

export type Range = { start: number; end: number };

/**
 * The second the buffer reaches from `position`: the end of the range that holds it (or starts
 * within half a second after it, as a seek lands), 0 when none does. The track's length when the
 * buffer reaches its end (within half a second), so a whole track reads as whole.
 */
export function bufferedTo(ranges: Range[], position: number, duration: number): number {
  const at = Number.isFinite(position) ? Math.max(0, position) : 0;
  const range = ranges.find((one) => one.start <= at + 0.5 && one.end >= at);
  if (!range) return 0;
  if (Number.isFinite(duration) && duration > 0 && range.end >= duration - 0.5) return duration;
  return range.end;
}

/** The element's buffered ranges as plain ranges. */
export function rangesOf(buffered: { length: number; start(index: number): number; end(index: number): number }): Range[] {
  return Array.from({ length: buffered.length }, (_, index) => ({ start: buffered.start(index), end: buffered.end(index) }));
}
