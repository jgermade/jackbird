// Deleting songs, from the selection dialog's Delete tab (the owner, 2026-11-25). In a family
// library, to the server's trash (30 days, restored from Preferences, Server, Trash); in a folder
// (of this device or of a server), into the folder's quarantine (helpers/quarantine.ts: 30 days,
// then deleted for good); in a folder only read, or an iPod's, only out of the list, as before.
// One file at a time: a failure stops the batch and says which file and why, the ones done stay
// done, and they leave the list and the queue.

import { $toRaw } from "jq79";
import { folderOf, quarantinePath } from "../helpers/quarantine";
import type { RootSource } from "../types";
import { t, tn } from "./i18n";
import { library } from "./library";
import { doneWriting, writingFile } from "./progress";
import { activeRoot, dialogTrackIdsNow, dropTracks } from "./workspace";

/** How the dialog's tracks would go, for its text and its key. */
export type DeleteWay = "trash" | "quarantine" | "list";

/** What deleting does in a source: its trash, its quarantine, or (only read, an iPod) only the list. */
export function deleteWay(source: RootSource | undefined): DeleteWay {
  if (!source || source.readOnly || source.ipod) return "list";
  return source.kind === "library" ? "trash" : "quarantine";
}

const nameOf = (path: string): string => path.split("/").pop() ?? path;

/** Deletes the dialog's tracks as their source does. Resolves to whether it all went. */
export async function deleteDialogTracks(): Promise<boolean> {
  const root = activeRoot.value.data;
  const ids = dialogTrackIdsNow();
  if (!root || ids.length === 0 || library.saving) return false;
  const way = deleteWay(root.source);
  if (way === "list") {
    dropTracks(ids);
    library.infoMessage = tn("message.removed", ids.length);
    return true;
  }
  const byId = new Map($toRaw(root).tracks.map((track) => [track.id, track]));
  const paths = ids.flatMap((id) => (byId.get(id) ? [{ id, path: byId.get(id)!.relativePath }] : []));
  const vfs = root.source.vfs;
  const now = new Date();
  const done: string[] = [];
  let failure: string | null = null;
  library.saving = true;
  library.errorMessage = null;
  library.infoMessage = null;
  try {
    for (const [index, { id, path }] of paths.entries()) {
      writingFile(index + 1, paths.length, nameOf(path));
      try {
        if (way === "trash") {
          await vfs.delete(path);
        } else {
          const to = quarantinePath(path, now);
          await vfs.mkdir?.(folderOf(to));
          await vfs.rename(path, to);
        }
        done.push(id);
      } catch (error) {
        failure = t("message.deleteFailed", { name: nameOf(path), reason: error instanceof Error ? error.message : String(error) });
        break;
      }
    }
  } finally {
    doneWriting();
    library.saving = false;
    dropTracks(done);
  }
  const said = tn(way === "trash" ? "message.trashed" : "message.quarantined", done.length);
  if (failure) {
    library.errorMessage = done.length > 0 ? `${said} ${failure}` : failure;
    return false;
  }
  library.infoMessage = said;
  return true;
}
