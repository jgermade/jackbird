// What the player's <audio> element plays: a URL for a track's file, opened
// without reading its bytes into memory. The VFS (`root.vfs`) only reads whole
// files, which a player does not need: in the browser the root's directory
// handle gives the file itself, and the element reads it from disk as it
// plays. The Tauri app (ROADMAP/2026-11-04/rust-tag-engine-and-tauri.md, E4)
// adds its own branch here. See RECORD/2026-11-04.github-actions-workflows.WIP.md
// (13:15).
//
// The file is a snapshot: once it is rewritten (a save, another program), the
// browser stops reading it, without an error. The player opens it again.

import { audioMimeType } from "../helpers/formats";
import type { RootWorkspace } from "../types";

export type Media = {
  url: string;
  /** Whether the file was rewritten since it was opened (its size or date). */
  changed: (root: RootWorkspace) => Promise<boolean>;
  /** Gives the URL back; the media is no use after it. */
  release: () => void;
};

async function fileOf(root: RootWorkspace, relativePath: string): Promise<File> {
  const parts = relativePath.split("/").filter(Boolean);
  const name = parts.pop();
  if (!name) {
    throw new Error(`Not a file: ${relativePath}`);
  }
  let folder = root.rootHandle;
  for (const part of parts) {
    folder = await folder.getDirectoryHandle(part);
  }
  return (await folder.getFileHandle(name)).getFile();
}

/** Opens a track's file for playing. */
export async function openMedia(root: RootWorkspace, relativePath: string): Promise<Media> {
  const file = await fileOf(root, relativePath);
  // Typed by extension (E3-D2), so playing does not depend on the type the system gives the
  // file (none, for .flac, on some): a slice is still the file on disk, not read into memory.
  const url = URL.createObjectURL(file.slice(0, file.size, audioMimeType(relativePath) || file.type));
  return {
    url,
    changed: async (current) => {
      const now = await fileOf(current, relativePath);
      return now.size !== file.size || now.lastModified !== file.lastModified;
    },
    release: () => URL.revokeObjectURL(url)
  };
}
