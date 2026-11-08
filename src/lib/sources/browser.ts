// A root in the browser: a folder chosen through the File System Access API
// (vfs-sync's FSAAdapter), its directory handle kept for the session, its
// files read whole through the VFS and handed to the tag engine as wasm
// (../tags), played from the file itself. See
// RECORD/2026-08-11.musikmatch-rust-migration.WIP.md (E4-D1).
//
// Playback: the VFS only reads whole files, which a player does not need, so
// the root's directory handle gives the file itself and the element reads it
// from disk as it plays. The file is a snapshot: once it is rewritten (a
// save, another program) the browser stops reading it, without an error; the
// player opens it again (RECORD/2026-11-04.github-actions-workflows.WIP.md, 13:15).

import { FSAAdapter, isFSAAvailable, walk } from "@cloudauthn/vfs-sync";
import { audioMimeType } from "../../helpers/formats";
import type { Inspection, MediaHandle, RootSource, TrackMetadata } from "../../types";
import { checksums, readTags, writeTags } from "../tags";

async function fileOf(root: FileSystemDirectoryHandle, relativePath: string): Promise<File> {
  const parts = relativePath.split("/").filter(Boolean);
  const name = parts.pop();
  if (!name) {
    throw new Error(`Not a file: ${relativePath}`);
  }
  let folder = root;
  for (const part of parts) {
    folder = await folder.getDirectoryHandle(part);
  }
  return (await folder.getFileHandle(name)).getFile();
}

/** A root over a folder's handle. */
export function browserSource(vfs: FSAAdapter): RootSource {
  const handle = vfs.root;
  const stamp = async (path: string, size: number) => {
    const stat = await vfs.stat(path).catch(() => null);
    return { size: stat?.size ?? size, lastModified: stat?.mtime };
  };
  return {
    kind: "browser",
    vfs,
    saved: handle,
    walk: () => walk(vfs),
    async inspect(path, known): Promise<Inspection> {
      const bytes = await vfs.read(path);
      const sums = await checksums(bytes);
      const metadata = sums.fullChecksum === known ? null : await readTags(bytes);
      return { ...(await stamp(path, bytes.byteLength)), ...sums, metadata };
    },
    async save(path: string, previous: TrackMetadata, metadata: TrackMetadata): Promise<Inspection> {
      const bytes = await writeTags(await vfs.read(path), previous, metadata);
      await vfs.write(path, bytes);
      const sums = await checksums(bytes);
      // The date the disk gave the file, which the next load compares with.
      return { ...(await stamp(path, bytes.byteLength)), ...sums, metadata };
    },
    async openMedia(path): Promise<MediaHandle> {
      const file = await fileOf(handle, path);
      // Typed by extension (E3-D2): a slice is still the file on disk, not read into memory.
      const url = URL.createObjectURL(file.slice(0, file.size, audioMimeType(path) || file.type));
      return {
        url,
        changed: async () => {
          const now = await fileOf(handle, path);
          return now.size !== file.size || now.lastModified !== file.lastModified;
        },
        release: () => URL.revokeObjectURL(url)
      };
    },
    close: () => undefined
  };
}

/** Asks for a folder. */
export async function pickBrowserSource(noFsa: string): Promise<RootSource> {
  if (!isFSAAvailable()) {
    throw new Error(noFsa);
  }
  return browserSource(await FSAAdapter.pick());
}

/** Reopens a saved folder, if the browser still grants it. */
export async function restoreBrowserSource(handle: FileSystemDirectoryHandle): Promise<RootSource | null> {
  const vfs = FSAAdapter.fromHandle(handle);
  return (await vfs.ensurePermission()) ? browserSource(vfs) : null;
}
