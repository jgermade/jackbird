/**
 * The play queue as a list: tracks of any open roots, and which one is
 * current. Every change gives a new position (queue and index) and leaves
 * the one given untouched; an empty queue is `null`. The current track keeps
 * being the current one through every change but its own removal.
 *
 * Four parts: the tracks before the current one (played), the current one,
 * the ones queued on purpose (`queued`, by Play next and Add to queue), and
 * the ones suggested (the rest of a disc played). The queued ones come right
 * after the current one, before the suggested ones, after every change (see
 * settle), so the list reads in the order it plays. See
 * RECORD/2026-11-04.github-actions-workflows.WIP.md (22:00 and 23:10, W3) and
 * RECORD/2026-11-03.deck-design-system.WIP.md (2026-11-17 12:40).
 */

import type { PlaybackQueue, QueueItem } from "../types.ts";

/** A queue and its current track's index in it. */
export type QueuePosition = {
  queue: PlaybackQueue | null;
  index: number;
};

const EMPTY: QueuePosition = { queue: null, index: 0 };

/** A queue of one root's tracks, in order, as a folder plays. */
export function queueOf(rootId: string, trackIds: readonly string[], sourceLabel: string): PlaybackQueue {
  return { items: trackIds.map((trackId) => ({ rootId, trackId })), sourceLabel };
}

/** Whether two items are the same track of the same root. */
export function sameItem(a: QueueItem, b: QueueItem): boolean {
  return a.rootId === b.rootId && a.trackId === b.trackId;
}

function withItems(position: QueuePosition, items: QueueItem[], index: number): QueuePosition {
  if (!position.queue || items.length === 0) {
    return EMPTY;
  }
  return { queue: { ...position.queue, items }, index: Math.max(0, Math.min(index, items.length - 1)) };
}

/** An item as queued on purpose, or as suggested: only its root, its track and that mark. */
const marked = (item: QueueItem): QueueItem => ({ rootId: item.rootId, trackId: item.trackId, queued: true });
const plain = (item: QueueItem): QueueItem => ({ rootId: item.rootId, trackId: item.trackId });

/** How many tracks right after the current one were queued on purpose. */
export function queuedCount(position: QueuePosition): number {
  const { queue, index } = position;
  if (!queue) {
    return 0;
  }
  let count = 0;
  while (queue.items[index + 1 + count]?.queued) {
    count += 1;
  }
  return count;
}

/** Whether any of the queue's tracks, played ones included, was put there on purpose. */
export function hasQueued(position: QueuePosition): boolean {
  return !!position.queue?.items.some((item) => item.queued);
}

/**
 * The rule restored: after the current track, the queued ones first, then the
 * suggested ones, each in their order. The position given when it holds.
 */
export function settle(position: QueuePosition): QueuePosition {
  const { queue, index } = position;
  if (!queue) {
    return position;
  }
  const after = queue.items.slice(index + 1);
  const sorted = [...after.filter((item) => item.queued), ...after.filter((item) => !item.queued)];
  if (sorted.every((item, at) => item === after[at])) {
    return position;
  }
  return { queue: { ...queue, items: [...queue.items.slice(0, index + 1), ...sorted] }, index };
}

/**
 * The `at`-th track current: forward, the tracks it jumps over count as
 * played (queued ones too); back, the tracks that come after it again are
 * put in order (see settle).
 */
export function jumpTo(position: QueuePosition, at: number): QueuePosition {
  const { queue } = position;
  if (!queue || at < 0 || at >= queue.items.length) {
    return position;
  }
  return settle({ queue, index: at });
}

/**
 * `items`, queued on purpose, right after the current track, in their order.
 * With no queue, they become one, labelled `sourceLabel`, the first of them
 * current.
 */
export function playNextIn(position: QueuePosition, items: readonly QueueItem[], sourceLabel: string): QueuePosition {
  if (items.length === 0) {
    return position;
  }
  if (!position.queue) {
    return { queue: { items: items.map(marked), sourceLabel }, index: 0 };
  }
  const list = [...position.queue.items];
  list.splice(position.index + 1, 0, ...items.map(marked));
  return withItems(position, list, position.index);
}

/** `items`, queued on purpose, after the ones queued before them (and before the suggested ones); with no queue, as `playNextIn`. */
export function addTo(position: QueuePosition, items: readonly QueueItem[], sourceLabel: string): QueuePosition {
  if (items.length === 0) {
    return position;
  }
  if (!position.queue) {
    return { queue: { items: items.map(marked), sourceLabel }, index: 0 };
  }
  const list = [...position.queue.items];
  list.splice(position.index + 1 + queuedCount(position), 0, ...items.map(marked));
  return withItems(position, list, position.index);
}

/**
 * A disc (or a folder, a playlist) played from its `at`-th track, in place of
 * the queue: that track current, the ones after it suggested; the ones before
 * it left out.
 */
export function replaceWith(items: readonly QueueItem[], at: number, sourceLabel: string): QueuePosition {
  if (at < 0 || at >= items.length) {
    return EMPTY;
  }
  return { queue: { items: items.slice(at).map(plain), sourceLabel }, index: 0 };
}

/**
 * A disc played from its `at`-th track, keeping the queue: what was played
 * and the track that was playing stay as played; the disc's track plays, the
 * tracks queued on purpose come right after it, and the disc's next tracks
 * are the suggested ones (the suggested ones before go). With no queue, as
 * `replaceWith`.
 */
export function playFrom(position: QueuePosition, items: readonly QueueItem[], at: number, sourceLabel: string): QueuePosition {
  const { queue, index } = position;
  if (!queue) {
    return replaceWith(items, at, sourceLabel);
  }
  if (at < 0 || at >= items.length) {
    return position;
  }
  const queued = queue.items.slice(index + 1, index + 1 + queuedCount(position));
  return {
    queue: { items: [...queue.items.slice(0, index + 1), plain(items[at]), ...queued, ...items.slice(at + 1).map(plain)], sourceLabel },
    index: index + 1
  };
}

/** The `at`-th track queued on purpose (`queued`) or suggested, where it is, the order kept (see settle). */
export function markQueued(position: QueuePosition, at: number, queued: boolean): QueuePosition {
  const { queue, index } = position;
  if (!queue || at <= index || at >= queue.items.length || !!queue.items[at].queued === queued) {
    return position;
  }
  const list = [...queue.items];
  list[at] = queued ? marked(list[at]) : plain(list[at]);
  return settle(withItems(position, list, index));
}

/** The queue without its `at`-th track; the current track cannot be removed this way. */
export function removeAt(position: QueuePosition, at: number): QueuePosition {
  const { queue, index } = position;
  if (!queue || at === index || at < 0 || at >= queue.items.length) {
    return position;
  }
  const list = queue.items.filter((_, item) => item !== at);
  return withItems(position, list, at < index ? index - 1 : index);
}

/**
 * The `from`-th track moved to `to`; the current track stays current wherever
 * it ends up. `queued`, when given: the track is queued on purpose there, or
 * suggested (the order then kept, see settle).
 */
export function moveTo(position: QueuePosition, from: number, to: number, queued?: boolean): QueuePosition {
  const { queue, index } = position;
  if (!queue || from < 0 || to < 0 || from >= queue.items.length || to >= queue.items.length) {
    return position;
  }
  if (from === to) {
    return queued === undefined ? position : markQueued(position, from, queued);
  }
  const list = [...queue.items];
  const [taken] = list.splice(from, 1);
  const moved = queued === undefined ? taken : queued ? marked(taken) : plain(taken);
  list.splice(to, 0, moved);
  let current = index;
  if (from === index) {
    current = to;
  } else if (from < index && to >= index) {
    current = index - 1;
  } else if (from > index && to <= index) {
    current = index + 1;
  }
  const next = withItems(position, list, current);
  return queued === undefined ? next : settle(next);
}

/** The queue up to the current track, without what comes after it. */
export function clearUpcoming(position: QueuePosition): QueuePosition {
  if (!position.queue) {
    return position;
  }
  return withItems(position, position.queue.items.slice(0, position.index + 1), position.index);
}

/** The queue from the current track on: the ones played before it removed. */
export function clearPlayed(position: QueuePosition): QueuePosition {
  if (!position.queue) {
    return position;
  }
  return withItems(position, position.queue.items.slice(position.index), 0);
}

/**
 * The queue without the items `gone` matches (a closed root's, or tracks
 * removed from the library). The current track stays current if it stays;
 * if it goes, the next one that stays becomes current (or the last one, when
 * none after it does), and `currentGone` says so.
 */
export function dropItems(position: QueuePosition, gone: (item: QueueItem) => boolean): QueuePosition & { currentGone: boolean } {
  const { queue, index } = position;
  if (!queue) {
    return { ...position, currentGone: false };
  }
  const currentGone = gone(queue.items[index]);
  const kept: QueueItem[] = [];
  let current = -1;
  queue.items.forEach((item, at) => {
    if (gone(item)) return;
    if (current === -1 && at >= index) current = kept.length;
    kept.push(item);
  });
  if (kept.length === queue.items.length) {
    return { ...position, currentGone: false };
  }
  const next = withItems(position, kept, current === -1 ? kept.length - 1 : current);
  return { ...next, currentGone };
}

/**
 * The queue saved before a reload, as far as the roots reopened: the items
 * whose roots are open, the same track current. `null` when the current
 * track's root did not reopen.
 */
export function restoreQueue(saved: QueuePosition, openRoots: ReadonlySet<string>): QueuePosition | null {
  const { queue, index } = saved;
  if (!queue || !queue.items[index] || !openRoots.has(queue.items[index].rootId)) {
    return null;
  }
  const dropped = dropItems(saved, (item) => !openRoots.has(item.rootId));
  return { queue: dropped.queue, index: dropped.index };
}

/**
 * Shuffle, an action (the owner, 2026-11-25): the tracks after the current one in an order of
 * chance, all of them now queued on purpose (none suggested by the list any more), and the queue no
 * longer named after the list it came from. The played ones and the current one stay where they are.
 */
export function shuffleUpcoming(position: QueuePosition, random: () => number = Math.random): QueuePosition {
  const { queue, index } = position;
  if (!queue) return position;
  const after = queue.items.slice(index + 1).map(marked);
  for (let at = after.length - 1; at > 0; at -= 1) {
    const other = Math.floor(random() * (at + 1));
    [after[at], after[other]] = [after[other], after[at]];
  }
  return { queue: { items: [...queue.items.slice(0, index + 1), ...after], sourceLabel: "" }, index };
}
