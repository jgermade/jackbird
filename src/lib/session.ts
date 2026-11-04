// The session: the open roots and the active one, kept in IndexedDB
// (rootSessionStore.ts) so that a reload reopens them. The former React
// view's restore and save effects as they were, except that a save is skipped when
// nothing it keeps has changed. See
// RECORD/2026-11-03.deck-design-system.WIP.md (steps 6 and 7).

import { FSAAdapter } from "@cloudauthn/vfs-sync";
import { $toRaw } from "jq79";
import { sameSession, sessionOf, type Session } from "../helpers/session";
import { library } from "./library";
import { loadRootSession, saveRootSession } from "./rootSessionStore";
import { hydrateRoot } from "./roots";

/**
 * Reopens the roots saved last time that still have permission, in their
 * order, then makes the saved active one active again (else the first
 * reopened). A session that cannot be read leaves a clean start. Restoring is
 * over when it returns.
 */
export async function restoreSession(): Promise<void> {
  try {
    const session = await loadRootSession();
    const reopened: string[] = [];

    for (const saved of session.roots) {
      const vfs = FSAAdapter.fromHandle(saved.handle);
      if (!(await vfs.ensurePermission())) {
        continue;
      }
      await hydrateRoot(vfs, {
        rootHandle: saved.handle,
        rootId: saved.id,
        rootLabel: saved.label,
        groupingMode: saved.groupingMode,
        setActive: false
      });
      reopened.push(saved.id);
    }

    if (session.activeRootId && reopened.includes(session.activeRootId)) {
      library.activeRootId = session.activeRootId;
    } else if (reopened.length > 0) {
      library.activeRootId = reopened[0];
    }
  } catch {
    // Nothing to reopen: start clean.
  } finally {
    library.restoring = false;
  }
}

/**
 * Saves the session whenever the open roots or the active one change, once
 * restoring is over (so that it does not overwrite the session it is
 * reading). Returns the function that stops it.
 */
export function keepSessionSaved(): () => void {
  let last: Session<FileSystemDirectoryHandle> | null = null;

  return library.$effect(() => {
    // Read first, so the effect wakes on all three.
    const roots = library.roots;
    const activeRootId = library.activeRootId;
    if (library.restoring) {
      return;
    }
    const next = sessionOf($toRaw(roots), activeRootId);
    if (sameSession(last, next)) {
      return;
    }
    last = next;
    saveRootSession(next).catch(() => {
      last = null;
    });
  });
}
