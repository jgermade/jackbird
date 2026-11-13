// A folder in a browser with no File System Access (Safari, Firefox): chosen through a folder file
// input (`webkitdirectory`), which hands over every file under it, to read and nothing more. The
// root is read-only: it plays and its tags are read, but nothing is written to the folder. What the
// app keeps beside the music (`.meta/`, playlists) stays in memory for the session, and the folder
// is not reopened after a reload (a file input keeps no hold on it). See helpers/picked.ts.

import { MemoryAdapter, type VFSAdapter, type VFSListEntry, type VFSStat, type WalkedFile } from "@cloudauthn/vfs-sync";
import { audioMimeType } from "../../helpers/formats";
import { folderAccess, isHandheld, splitPicked, type FolderAccess } from "../../helpers/picked";
import type { Inspection, MediaHandle, RootSource } from "../../types";
import { checksums, readTags } from "../tags";

/** What this browser can do with a folder of the person's (helpers/picked.ts). */
export function folderAccessHere(): FolderAccess {
  if (typeof window === "undefined") return "none";
  return folderAccess({
    picker: typeof window.showDirectoryPicker === "function",
    folderInput: typeof HTMLInputElement !== "undefined" && "webkitdirectory" in HTMLInputElement.prototype,
    handheld: isHandheld(navigator.userAgent, navigator.maxTouchPoints ?? 0)
  });
}

/**
 * The folder's files, read only; what the app writes beside them kept in memory. A real file can
 * be neither changed nor moved: the app does not offer to (its menus and dialogs ask `readOnly`),
 * and if it did, the write would fail here, not reach the disk.
 */
class PickedFolder implements VFSAdapter {
  private readonly kept: MemoryAdapter;

  constructor(
    readonly name: string,
    readonly files: ReadonlyMap<string, File>
  ) {
    this.kept = new MemoryAdapter(name);
  }

  private holds(path: string): boolean {
    for (const one of this.files.keys()) if (one.startsWith(`${path}/`)) return true;
    return false;
  }

  async list(path: string): Promise<VFSListEntry[]> {
    const prefix = path ? `${path}/` : "";
    const seen = new Map<string, VFSListEntry>();
    for (const entry of await this.kept.list(path)) seen.set(entry.path, entry);
    for (const [whole, file] of this.files) {
      if (!whole.startsWith(prefix)) continue;
      const [name, ...deeper] = whole.slice(prefix.length).split("/");
      const at = prefix + name;
      if (seen.has(at)) continue;
      seen.set(at, deeper.length > 0 ? { name, path: at, kind: "directory" } : { name, path: at, kind: "file", stat: statOf(file) });
    }
    return [...seen.values()];
  }

  async read(path: string): Promise<Uint8Array> {
    if (await this.kept.stat(path)) return this.kept.read(path);
    const file = this.files.get(path);
    if (!file) throw new DOMException(`Not found: ${path}`, "NotFoundError");
    return new Uint8Array(await file.arrayBuffer());
  }

  async stat(path: string): Promise<VFSStat | null> {
    const kept = await this.kept.stat(path);
    if (kept) return kept;
    const file = this.files.get(path);
    if (file) return statOf(file);
    return path === "" || this.holds(path) ? { kind: "directory", size: 0, mtime: 0 } : null;
  }

  write(path: string, data: Uint8Array): Promise<void> {
    if (this.files.has(path)) return Promise.reject(readOnly(path));
    return this.kept.write(path, data);
  }

  async delete(path: string): Promise<void> {
    if (await this.kept.stat(path)) return this.kept.delete(path);
    throw readOnly(path);
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    if (await this.kept.stat(oldPath)) return this.kept.rename(oldPath, newPath);
    throw readOnly(oldPath);
  }
}

const statOf = (file: File): VFSStat => ({ kind: "file", size: file.size, mtime: file.lastModified });
const readOnly = (path: string): Error => new DOMException(`Read-only: ${path}`, "NoModificationAllowedError");

/** A root over the folder's files. */
function pickedSource(vfs: PickedFolder): RootSource {
  return {
    kind: "browser",
    readOnly: true,
    vfs,
    // Not kept between sessions (session.ts and recent.ts skip a read-only root): only told apart.
    saved: `picked:${vfs.name}:${Date.now()}`,
    walk: async (): Promise<WalkedFile[]> => [...vfs.files].map(([path, file]) => ({ path, stat: statOf(file) })),
    async inspect(path, known): Promise<Inspection> {
      const file = vfs.files.get(path);
      if (!file) throw new DOMException(`Not found: ${path}`, "NotFoundError");
      const bytes = new Uint8Array(await file.arrayBuffer());
      const sums = await checksums(bytes);
      const metadata = sums.fullChecksum === known ? null : await readTags(bytes);
      return { size: file.size, lastModified: file.lastModified, ...sums, metadata };
    },
    save: (path) => Promise.reject(readOnly(path)),
    async openMedia(path): Promise<MediaHandle> {
      const file = vfs.files.get(path);
      if (!file) throw new DOMException(`Not found: ${path}`, "NotFoundError");
      // Typed by extension (E3-D2): a slice is still the file on disk, not read into memory.
      const url = URL.createObjectURL(file.slice(0, file.size, audioMimeType(path) || file.type));
      // The input's files are snapshots: a file rewritten since is not read again.
      return { url, changed: async () => false, release: () => URL.revokeObjectURL(url) };
    },
    close: () => undefined
  };
}

/**
 * Asks for a folder through a folder file input; null when the person cancels. Called straight
 * from the click (no wait before it), or Safari opens no dialog.
 */
export function pickReadOnlySource(): Promise<RootSource | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.webkitdirectory = true;
    input.multiple = true;
    input.hidden = true;
    const done = (source: RootSource | null) => {
      input.remove();
      resolve(source);
    };
    input.addEventListener("cancel", () => done(null), { once: true });
    input.addEventListener(
      "change",
      () => {
        const files = new Map<string, File>();
        let label = "";
        for (const file of input.files ?? []) {
          const picked = splitPicked(file.webkitRelativePath);
          if (!picked) continue;
          label ||= picked.folder;
          files.set(picked.path, file);
        }
        if (!label) return done(null);
        done(pickedSource(new PickedFolder(label, files)));
      },
      { once: true }
    );
    // Safari opens the dialog of an input in the page only.
    document.body.append(input);
    input.click();
  });
}
