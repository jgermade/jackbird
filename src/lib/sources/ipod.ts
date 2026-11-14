// An iPod as a root, in the desktop app (the panel, RECORD/2026-11-14.ipod-sync.WIP.md): its songs
// as its database lists them (src-tauri/src/ipod.rs), so the AAC ones show too, with their covers;
// played from its disk; never written to as a folder (`readOnly`): what the app keeps beside a
// folder's files (`.meta/`) stays in memory. Songs reach it and leave it only through `sendToIpod`
// and `removeFromIpod`, which rewrite its databases.

import { MemoryAdapter, type WalkedFile } from "@cloudauthn/vfs-sync";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import type { Inspection, MediaHandle, RootSource, TagsBatch } from "../../types";
import { TagError } from "../tags";

type Failure = { code: string; message: string };

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    const failure = error as Partial<Failure>;
    throw new TagError(failure.code ?? "io", failure.message ?? String(error));
  }
}

/** An iPod mounted on this machine. */
export type IpodInfo = { path: string; name: string; writable: boolean; reason: string | null; needsSysinfo: boolean };

/** A song sent: its path in the folder, where it went, and whether its cover went with it. */
export type Sent = { path: string; to: string; cover: boolean };

type IpodTracks = { tracks: TagsBatch["tracks"]; covers: TagsBatch["covers"]; pids: [string, string][] };
type MediaUrl = { kind: "asset"; path: string } | { kind: "http"; url: string };

/** The iPods mounted on this machine. */
export const listIpods = (): Promise<IpodInfo[]> => call<IpodInfo[]>("ipods");

/** Reads an iPod's SysInfoExtended over USB and keeps it on its disk (the one plugged in). */
export const saveSysinfo = (path: string): Promise<void> => call<void>("ipod_save_sysinfo", { path });

/** Sends files of the app's open folders to an iPod: into its master playlist, and `playlist` when named. */
export const sendFiles = (path: string, files: { root: string; path: string }[], playlist?: string): Promise<Sent[]> =>
  call<Sent[]>("ipod_send", { path, files, playlist: playlist ?? null });

/** Takes songs off an iPod, by their pids. */
export const removePids = (path: string, pids: string[]): Promise<number> => call<number>("ipod_remove", { path, pids });

/** An iPod's root: a desktop root over its mount point, with the songs its database lists. */
function ipodSource(root: string, name: string): RootSource {
  let listing: Promise<IpodTracks> | null = null;
  const load = (): Promise<IpodTracks> => (listing ??= call<IpodTracks>("ipod_tracks", { path: root, knownCovers: [] }));
  const pids = async (): Promise<Map<string, string>> => new Map((await load()).pids);
  const readOnly = (path: string): Error => new DOMException(`Read-only: ${path}`, "NoModificationAllowedError");
  return {
    kind: "desktop",
    readOnly: true,
    ipod: { path: root, pidOf: async (path) => (await pids()).get(path) },
    vfs: new MemoryAdapter(name),
    saved: `ipod:${root}`,
    isTrack: () => true,
    walk: async (): Promise<WalkedFile[]> =>
      (await load()).tracks.map((track) => ({ path: track.path, stat: { kind: "file", size: track.size, mtime: track.lastModified } })),
    async scanTags(paths, knownCovers, take) {
      const found = await load();
      const wanted = new Set(paths);
      const known = new Set(knownCovers);
      take({
        done: true,
        tracks: found.tracks.filter((track) => wanted.has(track.path)),
        covers: found.covers.filter((cover) => !known.has(cover.name)),
        unread: []
      });
    },
    // Its songs' fields come from its database, not their files: the same again, with no checksum
    // (an iPod's files are not hashed: reading them all would take long over USB).
    async inspect(path): Promise<Inspection> {
      const track = (await load()).tracks.find((one) => one.path === path);
      if (!track) throw new DOMException(`Not found: ${path}`, "NotFoundError");
      return { size: track.size, lastModified: track.lastModified, fullChecksum: "", audioChecksum: "", metadata: track.metadata };
    },
    save: (path) => Promise.reject(readOnly(path)),
    async openMedia(path): Promise<MediaHandle> {
      const found = await call<MediaUrl>("media_url", { root, path });
      return {
        url: found.kind === "asset" ? convertFileSrc(found.path) : found.url,
        changed: async () => false,
        release: () => undefined,
        native: { root, path }
      };
    },
    close: () => void invoke("close_root", { root }).catch(() => undefined)
  };
}

/** Opens an iPod as a root. */
export async function openIpod(info: IpodInfo): Promise<RootSource> {
  await call("ipod_open", { path: info.path });
  return ipodSource(info.path, info.name);
}
