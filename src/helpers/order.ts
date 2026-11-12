/**
 * The order the queue plays in, with repeat and shuffle: which tracks come after the current one,
 * which one before it, and the shuffled order itself. Indices are the queue's. See
 * RECORD/2026-11-03.deck-design-system.WIP.md (2026-11-13 21:30).
 */

export type Repeat = "off" | "all" | "one";
export type PlayMode = { repeat: Repeat; shuffle: boolean; order: readonly number[] };

/** Whether `order` is a shuffled order of a queue of `total`: each index once. */
export function isOrderOf(order: readonly number[], total: number): boolean {
  if (order.length !== total) return false;
  const seen = new Set(order);
  return seen.size === total && order.every((index) => Number.isInteger(index) && index >= 0 && index < total);
}

/** A shuffled order of a queue of `total`, `first` first (the track playing); `random` gives 0 to 1. */
export function shuffledOrder(total: number, first: number, random: () => number = Math.random): number[] {
  const rest = Array.from({ length: total }, (_, index) => index).filter((index) => index !== first);
  for (let at = rest.length - 1; at > 0; at -= 1) {
    const other = Math.floor(random() * (at + 1));
    [rest[at], rest[other]] = [rest[other], rest[at]];
  }
  return first >= 0 && first < total ? [first, ...rest] : rest;
}

/** The order tracks are played in: the shuffled one, or the queue's own. */
function sequence(total: number, mode: PlayMode): number[] {
  return mode.shuffle && isOrderOf(mode.order, total) ? [...mode.order] : Array.from({ length: total }, (_, index) => index);
}

/**
 * The tracks after `index`, in the order they play: to the end, and round again from the start
 * with repeat on (each once, the current one last). Repeating one, none: the same plays again,
 * which the player does itself.
 */
export function upcoming(index: number, total: number, mode: PlayMode): number[] {
  if (total <= 0 || mode.repeat === "one") return [];
  const order = sequence(total, mode);
  const at = order.indexOf(index);
  const after = order.slice(at + 1);
  return mode.repeat === "all" ? [...after, ...order.slice(0, at + 1)].filter((one, place, all) => all.indexOf(one) === place && (one !== index || place === all.length - 1)) : after;
}

/** The track after `index` (the next key, or the end of one): the same one past the end with repeat off. */
export function nextIndex(index: number, total: number, mode: PlayMode): number {
  if (total <= 0) return 0;
  if (mode.repeat === "one") return index;
  return upcoming(index, total, mode)[0] ?? index;
}

/** The track before `index` (the previous key): round to the last with repeat on; the same one at the start with it off. */
export function previousIndex(index: number, total: number, mode: PlayMode): number {
  if (total <= 0) return 0;
  const order = sequence(total, mode);
  const at = order.indexOf(index);
  if (at > 0) return order[at - 1];
  return mode.repeat === "all" ? order[order.length - 1] : index;
}

/** The repeat key's turn: off, the whole queue, this track, off again. */
export function nextRepeat(repeat: Repeat): Repeat {
  return repeat === "off" ? "all" : repeat === "all" ? "one" : "off";
}
