import type { GroupingMode, PlaybackQueue } from "../types.ts";

/**
 * What the session keeps of one open root: enough to reopen it after a
 * reload, where it was: its open folders and its current row (what the
 * album sheet showed). A session saved before those were kept has neither.
 */
export type SessionRoot<Handle> = {
  id: string;
  label: string;
  handle: Handle;
  groupingMode: GroupingMode;
  expandedAlbums?: string[];
  activeRowKey?: string | null;
};

/** The open roots, in tab order, and the active one. */
export type Session<Handle> = {
  roots: SessionRoot<Handle>[];
  activeRootId: string | null;
};

type OpenRoot<Handle> = {
  id: string;
  label: string;
  rootHandle: Handle;
  groupingMode: GroupingMode;
  expandedAlbums: readonly string[];
  activeRowKey: string | null;
};

/** The session to save for these open roots. */
export function sessionOf<Handle>(roots: readonly OpenRoot<Handle>[], activeRootId: string | null): Session<Handle> {
  return {
    roots: roots.map((root) => ({
      id: root.id,
      label: root.label,
      handle: root.rootHandle,
      groupingMode: root.groupingMode,
      expandedAlbums: [...root.expandedAlbums],
      activeRowKey: root.activeRowKey
    })),
    activeRootId
  };
}

/**
 * Whether saving `next` would change what was last saved: the same roots in
 * the same order (each handle the same object, with the same open folders,
 * in order, and the same current row) and the same active root. Nothing
 * saved yet always differs.
 */
export function sameSession<Handle>(last: Session<Handle> | null, next: Session<Handle>): boolean {
  if (!last || last.activeRootId !== next.activeRootId || last.roots.length !== next.roots.length) {
    return false;
  }
  return last.roots.every((root, index) => {
    const other = next.roots[index];
    const open = root.expandedAlbums ?? [];
    const otherOpen = other.expandedAlbums ?? [];
    return (
      root.id === other.id &&
      root.label === other.label &&
      root.handle === other.handle &&
      root.groupingMode === other.groupingMode &&
      (root.activeRowKey ?? null) === (other.activeRowKey ?? null) &&
      open.length === otherOpen.length &&
      open.every((folder, at) => folder === otherOpen[at])
    );
  });
}

/** What the tab keeps of the music across a reload (`sessionStorage`). */
export type SavedPlayback = {
  queue: PlaybackQueue;
  index: number;
  /** Seconds into the track. */
  position: number;
  playing: boolean;
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/**
 * The music saved before a reload, from its text; `null` when there is none
 * or it is not one: a queue of track ids, an index inside it, a position of
 * zero or more seconds, and whether it played.
 */
export function parsePlaybackState(raw: string | null): SavedPlayback | null {
  if (!raw) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || !isRecord(parsed.queue)) {
      return null;
    }
    const { queue, index, position, playing } = parsed;
    const { rootId, trackIds, sourceLabel } = queue;
    const valid =
      typeof rootId === "string" &&
      typeof sourceLabel === "string" &&
      Array.isArray(trackIds) &&
      trackIds.length > 0 &&
      trackIds.every((id) => typeof id === "string") &&
      Number.isInteger(index) &&
      (index as number) >= 0 &&
      (index as number) < trackIds.length &&
      typeof position === "number" &&
      Number.isFinite(position) &&
      position >= 0 &&
      typeof playing === "boolean";
    return valid ? { queue: { rootId, trackIds: [...trackIds], sourceLabel }, index: index as number, position, playing } : null;
  } catch {
    return null;
  }
}

/** What the tab keeps of the view across a reload (`sessionStorage`): the phone's panel and the panes' scroll. */
export type SavedView = {
  panel: "library" | "details";
  treeScroll: number;
  sheetScroll: number;
};

/** The view saved before a reload, from its text; anything missing or wrong reads as the start (the library, at the top). */
export function parseViewState(raw: string | null): SavedView {
  const start: SavedView = { panel: "library", treeScroll: 0, sheetScroll: 0 };
  if (!raw) {
    return start;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) {
      return start;
    }
    const scroll = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);
    return {
      panel: parsed.panel === "details" ? "details" : "library",
      treeScroll: scroll(parsed.treeScroll),
      sheetScroll: scroll(parsed.sheetScroll)
    };
  } catch {
    return start;
  }
}
