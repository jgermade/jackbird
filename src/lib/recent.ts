// The folders closed lately (the owner's request, 2026-11-12): what the session kept of each (a
// directory handle, a path, a server's root, a phone's folder) and its label, newest first, so
// "Add to the library…"'s Folder tab offers them again. Kept in IndexedDB beside the session
// (./rootSessionStore), which can hold the browser's directory handles. Reopening one asks its
// source as a restart would (./sources' restoreSource).
// See RECORD/2026-08-11.musikmatch-rust-migration.WIP.md (2026-11-12).

import { $reactive, $toRaw } from "jq79";
import { loadRecentRoots, saveRecentRoots, type RecentRoot } from "./rootSessionStore";

export type { RecentRoot };

/** How many closed folders are remembered. */
const KEPT = 8;

export const recent = $reactive({
  list: [] as RecentRoot[]
});

const same = (one: RecentRoot["saved"], other: RecentRoot["saved"]): boolean => typeof one === "string" && one === other;

function keep(list: RecentRoot[]): void {
  recent.list = list;
  void saveRecentRoots(list.map((entry) => ({ label: entry.label, saved: $toRaw(entry.saved) }))).catch(() => undefined);
}

/** Reads what was kept, once, when the app starts. */
export async function loadRecent(): Promise<void> {
  recent.list = await loadRecentRoots().catch(() => []);
}

/** A folder was closed: remembered first. */
export function rememberClosed(entry: RecentRoot): void {
  const others = $toRaw(recent).list.filter((one) => !same(one.saved, entry.saved) && one.saved !== entry.saved);
  keep([entry, ...others].slice(0, KEPT));
}

/** A folder was opened (or could not be): no longer offered. */
export function forgetRecent(saved: RecentRoot["saved"]): void {
  const list = $toRaw(recent).list;
  const rest = list.filter((one) => !same(one.saved, saved) && one.saved !== saved);
  if (rest.length !== list.length) keep(rest);
}
