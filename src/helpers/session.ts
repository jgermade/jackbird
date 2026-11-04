import type { GroupingMode } from "../types.ts";

/** What the session keeps of one open root: enough to reopen it after a reload. */
export type SessionRoot<Handle> = {
  id: string;
  label: string;
  handle: Handle;
  groupingMode: GroupingMode;
};

/** The open roots, in tab order, and the active one. */
export type Session<Handle> = {
  roots: SessionRoot<Handle>[];
  activeRootId: string | null;
};

type OpenRoot<Handle> = { id: string; label: string; rootHandle: Handle; groupingMode: GroupingMode };

/** The session to save for these open roots. */
export function sessionOf<Handle>(roots: readonly OpenRoot<Handle>[], activeRootId: string | null): Session<Handle> {
  return {
    roots: roots.map((root) => ({ id: root.id, label: root.label, handle: root.rootHandle, groupingMode: root.groupingMode })),
    activeRootId
  };
}

/**
 * Whether saving `next` would change what was last saved: the same roots in
 * the same order (each handle the same object) and the same active root.
 * Nothing saved yet always differs.
 */
export function sameSession<Handle>(last: Session<Handle> | null, next: Session<Handle>): boolean {
  if (!last || last.activeRootId !== next.activeRootId || last.roots.length !== next.roots.length) {
    return false;
  }
  return last.roots.every((root, index) => {
    const other = next.roots[index];
    return root.id === other.id && root.label === other.label && root.handle === other.handle && root.groupingMode === other.groupingMode;
  });
}
