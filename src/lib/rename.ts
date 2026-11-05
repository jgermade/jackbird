// Renaming the selected tracks from their tags (the selection dialog's
// Rename tab): the pattern, kept for the next time; the plan for the
// selection; and the renaming itself, which the library, `.meta/`, the
// selection, the current row, the queue, the player and the root's
// playlists follow. The pattern and the plan are helpers/rename.ts. See
// RECORD/2026-11-04.github-actions-workflows.WIP.md (22:00, 22:12, W5's plan).

import { $computed, $reactive, $toRaw } from "jq79";
import { RENAME_PRESETS, planRenames, type RenamePlan } from "../helpers/rename";
import type { MetaRecord, Mp3Track, RootWorkspace } from "../types";
import { t, tn } from "./i18n";
import { library } from "./library";
import { flushMeta } from "./meta";
import { Opaque } from "./opaque";
import { followRename } from "./player";
import { followRenameInPlaylists } from "./playlists";
import { updateRoots } from "./roots";
import { STORAGE_KEYS, readStored, writeStored } from "./storage";

/** The pattern being typed, as last used (or the first preset). */
export const renamer = $reactive({
  pattern: readStored(STORAGE_KEYS.renamePattern) || RENAME_PRESETS[0]
});

/** Sets the pattern, and keeps it for the next time. */
export function setRenamePattern(pattern: string): void {
  renamer.pattern = pattern;
  writeStored(STORAGE_KEYS.renamePattern, pattern);
}

/**
 * The plan for the active root's selection (boxed, see Opaque), derived from
 * the library store itself, not from another computed value.
 */
export const renamePlan = $computed((): Opaque<RenamePlan[]> => {
  const pattern = renamer.pattern;
  const root = library.roots.find((item) => item.id === library.activeRootId);
  if (!root) {
    return new Opaque([]);
  }
  const chosen = new Set(root.selectedTrackIds);
  const tracks = root.tracks.filter((track) => chosen.has(track.id));
  return new Opaque(planRenames(tracks, pattern, root.tracks.map((track) => track.relativePath)));
});

/** Whether the plan can run: something to rename, nothing clashing or empty. */
export function canRename(plans: readonly RenamePlan[]): boolean {
  return plans.some((plan) => plan.status === "ok") && !plans.some((plan) => plan.status === "clash" || plan.status === "empty");
}

const nameOf = (path: string): string => path.split("/").pop() ?? path;

/** A root with `renames` (old path to new) applied to its tracks, records, selection and current row. */
function renamedRoot(root: RootWorkspace, renames: ReadonlyMap<string, string>): RootWorkspace {
  const move = (id: string): string => renames.get(id) ?? id;
  const tracks: Mp3Track[] = root.tracks.map((track) => {
    const to = renames.get(track.id);
    return to ? { ...track, id: to, relativePath: to, name: nameOf(to) } : track;
  });
  const records: Record<string, MetaRecord> = {};
  for (const [path, record] of Object.entries(root.metaSnapshot.tracks)) {
    records[move(path)] = record;
  }
  const rowKey = root.activeRowKey?.startsWith("track:") ? `track:${move(root.activeRowKey.slice(6))}` : root.activeRowKey;
  return {
    ...root,
    tracks,
    metaSnapshot: { ...root.metaSnapshot, tracks: records },
    selectedTrackId: root.selectedTrackId ? move(root.selectedTrackId) : null,
    selectedTrackIds: root.selectedTrackIds.map(move),
    selectionAnchorTrackId: root.selectionAnchorTrackId ? move(root.selectionAnchorTrackId) : null,
    activeRowKey: rowKey
  };
}

/**
 * Renames the active root's selected tracks by the pattern, one file at a
 * time: refused while a name clashes or is empty, or the root is still being
 * read. Before each, the new name must be free on disk (it may hold a file
 * the library does not list); a failure stops the batch and says which file
 * and why, and the ones done stay done. Then the library, its `.meta/`, the
 * selection, the current row, the queue and the player follow, at once, and
 * `.meta/` is written. Says what was renamed. Resolves to whether it all went.
 */
export async function renameSelected(): Promise<boolean> {
  const root = $toRaw(library).roots.find((item) => item.id === $toRaw(library).activeRootId);
  const plans = $toRaw(renamePlan).value.data.filter((plan) => plan.status === "ok");
  if (!root || library.saving || root.loadingMetadata || !canRename($toRaw(renamePlan).value.data)) {
    return false;
  }
  library.saving = true;
  library.errorMessage = null;
  library.infoMessage = null;
  const done = new Map<string, string>();
  let failure: string | null = null;
  try {
    for (const plan of plans) {
      const caseOnly = plan.from.toLowerCase() === plan.to.toLowerCase();
      try {
        if (!caseOnly && (await root.vfs.stat(plan.to))) {
          throw new Error(t("rename.exists"));
        }
        await root.vfs.rename(plan.from, plan.to);
        done.set(plan.from, plan.to);
      } catch (error) {
        failure = t("message.renameFailed", { name: nameOf(plan.from), reason: error instanceof Error ? error.message : String(error) });
        break;
      }
    }
  } finally {
    if (done.size > 0) {
      updateRoots((roots) => roots.map((item) => (item.id === root.id ? renamedRoot(item, done) : item)));
      followRename(root.id, done);
      followRenameInPlaylists(root.id, done);
      await flushMeta(root.id).catch(() => undefined);
    }
    library.saving = false;
  }
  if (failure) {
    library.errorMessage = done.size > 0 ? `${tn("message.renamed", done.size)} ${failure}` : failure;
    return false;
  }
  library.infoMessage = tn("message.renamed", done.size);
  return true;
}
