// An iPod as a root, in the desktop app (the panel, RECORD/2026-11-14.ipod-sync.WIP.md): its songs
// as its database lists them (src-tauri/src/ipod.rs), so the AAC ones show too, with their covers;
// played from its disk; never written to as a folder (`readOnly`): what the app keeps beside a
// folder's files (`.meta/`) stays in memory. Songs reach it and leave it only through `sendToIpod`
// and `removeFromIpod`, which rewrite its databases.

import { MemoryAdapter, type WalkedFile } from "@cloudauthn/vfs-sync";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { rockboxLibraryPaths } from "../../helpers/ipod";
import { metaIn } from "../../helpers/meta-in";
import type { Inspection, IpodDeviceInfo, MediaHandle, RootSource, TagsBatch } from "../../types";
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

type IpodTracks = { tracks: TagsBatch["tracks"]; pids: [string, string][] };
type CoversBatch = { done: boolean; covers: TagsBatch["covers"] };
type MediaUrl = { kind: "asset"; path: string } | { kind: "http"; url: string };

/** The iPods mounted on this machine. */
export const listIpods = (): Promise<IpodInfo[]> => call<IpodInfo[]>("ipods");

/** The mount points that hold an iPod: cheap, for watching what is plugged in. */
export const ipodMounts = (): Promise<string[]> => call<string[]>("ipod_mounts");

/** Reads an iPod's SysInfoExtended over USB and keeps it on its disk (the one plugged in). */
export const saveSysinfo = (path: string): Promise<void> => call<void>("ipod_save_sysinfo", { path });

/** Sends files of the app's open folders to an iPod: into its master playlist, and `playlist` when named. */
export const sendFiles = (path: string, files: { root: string; path: string }[], playlist?: string): Promise<Sent[]> =>
  call<Sent[]>("ipod_send", { path, files, playlist: playlist ?? null });

/** Ejects an iPod: the system asked to let its drive go (W6). */
export const ejectDrive = (path: string): Promise<void> => call<void>("ipod_eject", { path });

/** Takes songs off an iPod, by their pids. */
export const removePids = (path: string, pids: string[]): Promise<number> => call<number>("ipod_remove", { path, pids });

/**
 * The covers the app has had from an iPod this session (lib/covers.ts keeps them): not asked for
 * again when its root is read again after a send.
 */
const coversHad = new Set<string>();

/** An iPod's root: a desktop root over its mount point, with the songs its database lists. */
function ipodSource(root: string, name: string): RootSource {
  let listing: Promise<IpodTracks> | null = null;
  // Its Rockbox library, made the first time it is asked for (W7).
  let rockbox: Promise<RootSource> | null = null;
  const load = (): Promise<IpodTracks> => (listing ??= call<IpodTracks>("ipod_tracks", { path: root }));
  const pids = async (): Promise<Map<string, string>> => new Map((await load()).pids);
  const readOnly = (path: string): Error => new DOMException(`Read-only: ${path}`, "NoModificationAllowedError");
  const self: RootSource = {
    kind: "desktop",
    readOnly: true,
    ipod: {
      path: root,
      pidOf: async (path) => (await pids()).get(path),
      info: () => call<IpodDeviceInfo>("ipod_info", { path: root }),
      library: "apple",
      counterpart: () => (rockbox ??= rockboxSource(root, name, self)),
      forget: () => {
        listing = null;
      }
    },
    vfs: new MemoryAdapter(name),
    saved: `ipod:${root}`,
    isTrack: () => true,
    walk: async (): Promise<WalkedFile[]> =>
      (await load()).tracks.map((track) => ({ path: track.path, stat: { kind: "file", size: track.size, mtime: track.lastModified } })),
    // The songs at once, from its database; their covers after, in batches, those the interface
    // lacks (the owner's rule, 2026-11-16: the information first, the pictures in the background).
    async scanTags(paths, knownCovers, take) {
      const found = await load();
      const wanted = new Set(paths);
      take({ done: false, tracks: found.tracks.filter((track) => wanted.has(track.path)), covers: [], unread: [] });
      const { streamed } = await import("./desktop");
      await streamed<CoversBatch>("ipod_covers", { path: root, knownCovers: [...new Set([...knownCovers, ...coversHad])] }, (batch) => {
        for (const cover of batch.covers) coversHad.add(cover.name);
        take({ done: batch.done, tracks: [], covers: batch.covers, unread: [] });
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
  return self;
}

/** Plays a file of the iPod at `root` from its disk, as a folder's. */
async function mediaOf(root: string, path: string): Promise<MediaHandle> {
  const found = await call<MediaUrl>("media_url", { root, path });
  return {
    url: found.kind === "asset" ? convertFileSrc(found.path) : found.url,
    changed: async () => false,
    release: () => undefined,
    native: { root, path }
  };
}

/** Where an iPod's Rockbox library keeps its `.meta/`: in Apple's folder, which Rockbox's library leaves out. */
export const ROCKBOX_META = "iPod_Control/jackbird";


/**
 * The Rockbox library of the iPod at `root` (W7): its drive as Rockbox's database lists it
 * (helpers/ipod.ts's `rockboxLibraryPaths`), read with the app's tag engine as a folder is, in
 * bulk. Its songs only read, as its Apple library: what it writes is its own `.meta/` and covers,
 * in `iPod_Control/jackbird/` (`metaIn`).
 */
async function rockboxSource(root: string, name: string, apple: RootSource): Promise<RootSource> {
  const readOnly = (path: string): Error => new DOMException(`Read-only: ${path}`, "NoModificationAllowedError");
  const { desktopVfs, streamed } = await import("./desktop");
  const self: RootSource = {
    kind: "desktop",
    readOnly: true,
    ipod: { path: root, pidOf: async () => undefined, info: apple.ipod!.info, library: "rockbox", counterpart: async () => apple },
    // Its `.meta/` kept on the iPod, in `iPod_Control/jackbird/` (the owner's idea, 2026-11-16): the
    // second opening lists it at once. Nothing else on the drive is written.
    vfs: metaIn(desktopVfs(root, name), ROCKBOX_META),
    saved: `ipod-rockbox:${root}`,
    async walk(): Promise<WalkedFile[]> {
      const all = await call<WalkedFile[]>("walk", { root });
      const kept = new Set(rockboxLibraryPaths(all.map((file) => file.path)));
      return all.filter((file) => kept.has(file.path));
    },
    scanTags: (paths, knownCovers, take) => streamed<TagsBatch>("scan", { root, paths, knownCovers, coversDir: `${ROCKBOX_META}/covers` }, take),
    inspect: (path, known) => call<Inspection>("inspect", { root, path, known: known ?? null }),
    save: (path) => Promise.reject(readOnly(path)),
    openMedia: (path) => mediaOf(root, path),
    close: () => void invoke("close_root", { root }).catch(() => undefined)
  };
  return self;
}

/** Opens an iPod as a root. */
export async function openIpod(info: IpodInfo): Promise<RootSource> {
  await call("ipod_open", { path: info.path });
  return ipodSource(info.path, info.name);
}
