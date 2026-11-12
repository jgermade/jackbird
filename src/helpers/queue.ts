/**
 * The play queue as a list: tracks of any open roots, and which one is
 * current. Every change gives a new position (queue and index) and leaves
 * the one given untouched; an empty queue is `null`. The current track keeps
 * being the current one through every change but its own removal. See
 * RECORD/2026-11-04.github-actions-workflows.WIP.md (22:00 and 23:10, W3).
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

/**
 * `items` right after the current track, in their order. With no queue,
 * they become one, labelled `sourceLabel`, the first of them current.
 */
export function playNextIn(position: QueuePosition, items: readonly QueueItem[], sourceLabel: string): QueuePosition {
  if (items.length === 0) {
    return position;
  }
  if (!position.queue) {
    return { queue: { items: [...items], sourceLabel }, index: 0 };
  }
  const list = [...position.queue.items];
  list.splice(position.index + 1, 0, ...items);
  return withItems(position, list, position.index);
}

/** `items` at the end of the queue; with no queue, as `playNextIn`. */
export function addTo(position: QueuePosition, items: readonly QueueItem[], sourceLabel: string): QueuePosition {
  if (items.length === 0) {
    return position;
  }
  if (!position.queue) {
    return { queue: { items: [...items], sourceLabel }, index: 0 };
  }
  return withItems(position, [...position.queue.items, ...items], position.index);
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

/** The `from`-th track moved to `to`; the current track stays current wherever it ends up. */
export function moveTo(position: QueuePosition, from: number, to: number): QueuePosition {
  const { queue, index } = position;
  if (!queue || from === to || from < 0 || to < 0 || from >= queue.items.length || to >= queue.items.length) {
    return position;
  }
  const list = [...queue.items];
  const [moved] = list.splice(from, 1);
  list.splice(to, 0, moved);
  let current = index;
  if (from === index) {
    current = to;
  } else if (from < index && to >= index) {
    current = index - 1;
  } else if (from > index && to <= index) {
    current = index + 1;
  }
  return withItems(position, list, current);
}

/** The queue up to the current track, without what comes after it. */
export function clearUpcoming(position: QueuePosition): QueuePosition {
  if (!position.queue) {
    return position;
  }
  return withItems(position, position.queue.items.slice(0, position.index + 1), position.index);
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

/** What `isOneAlbum` looks at in each queued track (null for one no longer in the library). */
export type AlbumPart = { album: string; artist: string; folder: string } | null;

/**
 * Whether a queue is one disc rather than a list: every track there, of the same album (named), and
 * either by the same artist or in the same folder (a compilation keeps its tracks together). Its
 * tracks played are not dimmed then: a disc plays through, a list is worked through. See
 * RECORD/2026-11-03.deck-design-system.WIP.md (2026-11-13 15:00).
 */
export function isOneAlbum(parts: readonly AlbumPart[]): boolean {
  if (parts.length < 2 || parts.some((part) => !part)) return false;
  const [first, ...rest] = parts as { album: string; artist: string; folder: string }[];
  const album = first.album.trim().toLowerCase();
  if (!album || rest.some((part) => part.album.trim().toLowerCase() !== album)) return false;
  return rest.every((part) => part.artist === first.artist) || rest.every((part) => part.folder === first.folder);
}
