// A root on jackbird's service (S1): a folder of the machine the service
// runs on, by its path, every operation an HTTP request to the page's own
// origin (crates/service). As on the desktop, the tags and checksums are
// worked out by the service; only small files (`.meta/`, playlists) travel
// whole. Playback is the service's own URL, with byte ranges. See
// RECORD/2026-08-11.musikmatch-rust-migration.WIP.md (S1-D5).

import type { VFSAdapter, VFSListEntry, VFSStat } from "@cloudauthn/vfs-sync";
import type { Inspection, MediaHandle, RootSource, TrackMetadata } from "../../types";
import { TagError } from "../tags";

type Failure = { code?: string; message?: string };

/** One request to the service; its failure becomes a TagError with the service's code. */
async function api(path: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(`/api/${path}`, init);
  if (!response.ok) {
    const failure: Failure = await response.json().catch(() => ({}));
    throw new TagError(failure.code ?? "io", failure.message ?? `${response.status} ${response.statusText}`);
  }
  return response;
}

const json = <T>(path: string, init?: RequestInit): Promise<T> => api(path, init).then((response) => response.json() as Promise<T>);
const post = (body?: unknown): RequestInit => ({
  method: "POST",
  ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
});
const at = (root: string, path = ""): string => `root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`;

function serviceVfs(root: string, name: string): VFSAdapter {
  return {
    name,
    list: (path) => json<VFSListEntry[]>(`list?${at(root, path)}`),
    read: async (path) => new Uint8Array(await (await api(`read?${at(root, path)}`)).arrayBuffer()),
    write: async (path, data) => {
      await api(`write?${at(root, path)}`, { method: "POST", body: data as Uint8Array<ArrayBuffer> });
    },
    delete: async (path) => {
      await api(`delete?${at(root, path)}`, post());
    },
    rename: async (from, to) => {
      await api("rename", post({ root, from, to }));
    },
    stat: (path) => json<VFSStat | null>(`stat?${at(root, path)}`),
    mkdir: async (path) => {
      await api(`mkdir?${at(root, path)}`, post());
    }
  };
}

function serviceSource(root: string, name: string): RootSource {
  const vfs = serviceVfs(root, name);
  return {
    kind: "service",
    vfs,
    saved: root,
    walk: () => json(`walk?${at(root)}`),
    inspect: (path, known) => json<Inspection>("inspect", post({ root, path, known: known ?? null })),
    save: (path: string, previous: TrackMetadata, metadata: TrackMetadata) =>
      json<Inspection>("save", post({ root, path, previous, metadata })),
    async openMedia(path): Promise<MediaHandle> {
      const before = await vfs.stat(path);
      return {
        url: `/api/media?${at(root, path)}`,
        changed: async () => {
          const now = await vfs.stat(path);
          return now?.size !== before?.size || now?.mtime !== before?.mtime;
        },
        release: () => undefined
      };
    },
    close: () => void api("roots/close", post({ root })).catch(() => undefined)
  };
}

type Opened = { path: string; name: string };

/** Opens a folder of the service's machine. */
export async function openServiceFolder(path: string): Promise<RootSource> {
  const opened = await json<Opened>("roots", post({ path }));
  return serviceSource(opened.path, opened.name);
}

/** Reopens a folder the session kept; null when it is gone. */
export function restoreServiceSource(path: string): Promise<RootSource | null> {
  return openServiceFolder(path).catch(() => null);
}

/** One folder of the service's machine, for the dialog: its subfolders and its parent. */
export type MachineFolder = { path: string; parent: string | null; folders: { name: string; path: string }[] };

/** The folders in a folder of the service's machine; its home when no path is given. */
export function machineFolder(path?: string): Promise<MachineFolder> {
  return json<MachineFolder>(path === undefined ? "folders" : `folders?path=${encodeURIComponent(path)}`);
}
