// A folder's `.meta/` kept elsewhere in it: an iPod's Rockbox library keeps its own in
// `iPod_Control/jackbird/` (RECORD/2026-11-14.ipod-sync.WIP.md, 2026-11-16).

import type { VFSAdapter } from "@cloudauthn/vfs-sync";

/**
 * A folder's small-file adapter whose `.meta/` lives in `dir` instead; it writes nothing else (a
 * write, removal or rename elsewhere is refused), and reads anything as the folder does.
 */
export function metaIn(vfs: VFSAdapter, dir: string): VFSAdapter {
  const meta = (path: string): string | null => {
    const clean = path.replace(/^\/+/, "");
    return clean === ".meta" || clean.startsWith(".meta/") ? `${dir}${clean.slice(".meta".length)}` : null;
  };
  const writable = (path: string): string => {
    const mapped = meta(path);
    if (mapped === null) throw new DOMException(`Read-only: ${path}`, "NoModificationAllowedError");
    return mapped;
  };
  return {
    name: vfs.name,
    list: (path) => vfs.list(meta(path) ?? path),
    read: (path) => vfs.read(meta(path) ?? path),
    stat: (path) => vfs.stat(meta(path) ?? path),
    write: async (path, data) => vfs.write(writable(path), data),
    delete: async (path) => vfs.delete(writable(path)),
    rename: async (from, to) => vfs.rename(writable(from), writable(to)),
    ...(vfs.mkdir ? { mkdir: async (path: string) => vfs.mkdir!(writable(path)) } : {})
  };
}
