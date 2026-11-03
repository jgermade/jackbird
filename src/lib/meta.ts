// The `.meta/mp3-manager.json` file in an opened folder: what the library
// knows about each track, so a reopened folder renders at once. The JSON
// half is in helpers/snapshot.ts; this is the reading and writing.

import type { VFSAdapter } from "@cloudauthn/vfs-sync";
import { emptySnapshot, parseMetaSnapshot, serializeMetaSnapshot } from "../helpers/snapshot";
import type { MetaSnapshot } from "../types";

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
