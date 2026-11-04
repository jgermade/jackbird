// The `.meta/mp3-manager.json` file in an opened folder: what the library
// knows about each track, so a reopened folder renders at once. The JSON
// half is in helpers/snapshot.ts; this is the reading and writing.

import type { VFSAdapter } from "@cloudauthn/vfs-sync";
import { $toRaw } from "jq79";
import { emptySnapshot, parseMetaSnapshot, serializeMetaSnapshot } from "../helpers/snapshot";
import type { MetaSnapshot } from "../types";
import { library } from "./library";

/** Renaming it needs a migration: it sits in every folder a user has opened. */
export const META_FILE_PATH = ".meta/mp3-manager.json";

export async function readMetaSnapshot(vfs: VFSAdapter): Promise<MetaSnapshot> {
  if (!(await vfs.stat(META_FILE_PATH))) {
    return emptySnapshot();
  }
  return parseMetaSnapshot(new TextDecoder().decode(await vfs.read(META_FILE_PATH)));
}

export async function writeMetaSnapshot(vfs: VFSAdapter, snapshot: MetaSnapshot): Promise<void> {
  await vfs.write(META_FILE_PATH, new TextEncoder().encode(serializeMetaSnapshot(snapshot)));
}

// The write under way (or last done) for each root, by id.
const writing = new Map<string, Promise<void>>();

/**
 * Writes an open root's snapshot to its `.meta/`, as the library holds it
 * when the write starts, after any write already under way for that root.
 * So two writes never overlap, and the last one written is the latest state:
 * a caller changes the library first, then flushes. Nothing is written for a
 * root that is no longer open. Rejects when this write fails; a failed write
 * does not stop the next one.
 */
export function flushMeta(rootId: string): Promise<void> {
  const write = (writing.get(rootId) ?? Promise.resolve())
    .catch(() => undefined)
    .then(async () => {
      const root = $toRaw(library).roots.find((item) => item.id === rootId);
      if (root) {
        await writeMetaSnapshot(root.vfs, root.metaSnapshot);
      }
    });
  writing.set(rootId, write);
  void write
    .catch(() => undefined)
    .then(() => {
      if (writing.get(rootId) === write) {
        writing.delete(rootId);
      }
    });
  return write;
}
