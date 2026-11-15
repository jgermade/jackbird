// An iPod opened in a browser (RECORD/2026-11-14.ipod-sync.WIP.md, W3): the drive the person
// picked, its songs as its database lists them (so its AAC songs show too), with their covers, and
// played from the drive. Only read: nothing is written to it, and what the app keeps beside a
// folder's files (`.meta/`) stays in memory, as for the desktop app's iPod (./ipod.ts). The
// database is read by the iPod's WebAssembly module (lib/ipod-db/wasm.ts), loaded only now.
//
// The songs come in the first batch, with their covers by reference; the covers follow, a few at a
// time, each made from its slot of the image files (read with `File.slice`: an `.ithmb` is tens of
// MB, and only the slots shown are read).

import { FSAAdapter, MemoryAdapter, type WalkedFile } from "@cloudauthn/vfs-sync";
import { audioMimeType } from "../../helpers/formats";
import { IPOD_ARTWORK, IPOD_DATABASES, inGroups, ipodCoverName, ipodSongMetadata } from "../../helpers/ipod";
import type { Inspection, MediaHandle, RootSource, TagsBatch } from "../../types";
import type { IpodDb, IpodImage, IpodListing, IpodSong } from "../ipod-db/wasm";
import { fileOf } from "./browser";
import { PickedFolder } from "./picked";

/** The files of a drive picked in a browser, by path: through a folder's handle, or a folder input's files. */
export type DriveFiles = {
  /** The drive's name, as the picker gave it ("NANO"). */
  readonly name: string;
  /** A file by its path under the drive; null when it has none. */
  file(path: string): Promise<File | null>;
};

/** A drive through a folder's handle (Chrome, Edge). */
export function handleDrive(handle: FileSystemDirectoryHandle): DriveFiles {
  return { name: handle.name, file: (path) => fileOf(handle, path).catch(() => null) };
}

/** A drive through a folder input's files, by their path under it (Safari, Firefox). */
export function filesDrive(name: string, files: ReadonlyMap<string, File>): DriveFiles {
  return { name, file: async (path) => files.get(path) ?? null };
}

/** The drive's database, the first of IPOD_DATABASES it has; null when it is not an iPod. */
export async function ipodDatabase(drive: DriveFiles): Promise<File | null> {
  for (const path of IPOD_DATABASES) {
    const file = await drive.file(path);
    if (file) return file;
  }
  return null;
}

/** The drive under a folder the person picked in the browser: through its handle, or the input's files. */
export function driveOf(source: RootSource): DriveFiles | null {
  if (source.vfs instanceof FSAAdapter) return handleDrive(source.vfs.root);
  if (source.vfs instanceof PickedFolder) return filesDrive(source.vfs.name, source.vfs.files);
  return null;
}

/** A folder picked in the browser, as an iPod when it holds an iPod's database (W4); null when it does not. */
export async function asWebIpod(source: RootSource): Promise<RootSource | null> {
  const drive = driveOf(source);
  const database = drive ? await ipodDatabase(drive) : null;
  return drive && database ? webIpodSource(drive, database) : null;
}

/** How many covers a batch hands over: about 30 ms of work each (W1's measure, 2.75 ms a cover). */
const COVERS_PER_BATCH = 10;

let module: Promise<IpodDb> | null = null;

/** The iPod's module, loaded once; loaded again if it broke. */
async function ipodDb(): Promise<IpodDb> {
  const loaded = module ? await module.catch(() => null) : null;
  if (loaded && !loaded.broken) return loaded;
  module = import("../ipod-db/wasm").then((wasm) => wasm.load());
  return module;
}

const bytesOf = async (file: Blob): Promise<Uint8Array> => new Uint8Array(await file.arrayBuffer());

/** Lets the page draw between batches. */
const breathe = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** An iPod's root over a drive that holds a database (`database`, found by ipodDatabase). */
export async function webIpodSource(drive: DriveFiles, database: File): Promise<RootSource> {
  const db = await ipodDb();
  const listing: IpodListing = db.list(await bytesOf(database));
  const songs = new Map<string, IpodSong>(listing.songs.map((song) => [song.path, song]));
  const coverOf = (song: IpodSong): string | null => (song.artwork === null ? null : ipodCoverName(drive.name, song.artwork));

  // The covers' database, read the first time a cover is needed; none when the iPod has none.
  let images: Promise<Map<number, IpodImage>> | null = null;
  const imagesOf = (): Promise<Map<number, IpodImage>> =>
    (images ??= drive
      .file(`${IPOD_ARTWORK}/ArtworkDB`)
      .then(async (file) => (file ? db.images(await bytesOf(file)) : []))
      .catch((error: unknown) => {
        console.error("jackbird: could not read the iPod's covers", error);
        return [];
      })
      .then((list) => new Map(list.map((image) => [image.id, image]))));
  // The image files, each looked up once.
  const imageFiles = new Map<string, Promise<File | null>>();
  const imageFile = (name: string): Promise<File | null> => {
    let file = imageFiles.get(name);
    if (!file) imageFiles.set(name, (file = drive.file(`${IPOD_ARTWORK}/${name}`)));
    return file;
  };
  /** A cover as a PNG; null when its image or its slot cannot be read. */
  const cover = async (image: IpodImage): Promise<Uint8Array | null> => {
    const file = await imageFile(image.file);
    if (!file) return null;
    try {
      return db.cover(image, await bytesOf(file.slice(image.offset, image.offset + image.size)));
    } catch (error) {
      console.error(`jackbird: could not read the iPod's cover ${image.id}`, error);
      return null;
    }
  };

  const listed = (path: string): IpodSong => {
    const song = songs.get(path);
    if (!song) throw new DOMException(`Not found: ${path}`, "NotFoundError");
    return song;
  };
  const readOnly = (path: string): Error => new DOMException(`Read-only: ${path}`, "NoModificationAllowedError");
  const label = listing.name || drive.name;

  return {
    kind: "browser",
    readOnly: true,
    ipod: { path: drive.name, web: true, pidOf: async (path) => songs.get(path)?.pid },
    vfs: new MemoryAdapter(label),
    // Not kept between sessions (session.ts and recent.ts skip a read-only root), as the desktop
    // app's iPod and a folder Safari can only read: only told apart.
    saved: `ipod-web:${drive.name}:${Date.now()}`,
    isTrack: () => true,
    walk: async (): Promise<WalkedFile[]> =>
      listing.songs.map((song) => ({ path: song.path, stat: { kind: "file", size: song.size, mtime: 0 } })),
    async scanTags(paths, knownCovers, take) {
      const wanted = paths.map((path) => songs.get(path)).filter((song): song is IpodSong => !!song);
      const tracks: TagsBatch["tracks"] = wanted.map((song) => ({
        path: song.path,
        size: song.size,
        lastModified: 0,
        metadata: ipodSongMetadata(song, coverOf(song))
      }));
      // The songs at once; their covers after, those the interface lacks, each image once.
      const known = new Set(knownCovers);
      const ids = [...new Set(wanted.map((song) => song.artwork).filter((id): id is number => id !== null))].filter(
        (id) => !known.has(ipodCoverName(drive.name, id))
      );
      take({ done: ids.length === 0, tracks, covers: [], unread: [] });
      if (ids.length === 0) return;
      const all = await imagesOf();
      const groups = inGroups(ids, COVERS_PER_BATCH);
      for (const [index, group] of groups.entries()) {
        await breathe();
        const covers: TagsBatch["covers"] = [];
        for (const id of group) {
          const image = all.get(id);
          const png = image ? await cover(image) : null;
          if (png) covers.push({ name: ipodCoverName(drive.name, id), data: "", bytes: png });
        }
        take({ done: index === groups.length - 1, tracks: [], covers, unread: [] });
      }
    },
    // Its songs' fields come from its database, not their files: the same again, with no checksum
    // (an iPod's files are not hashed, as in the desktop app).
    async inspect(path): Promise<Inspection> {
      const song = listed(path);
      return { size: song.size, lastModified: 0, fullChecksum: "", audioChecksum: "", metadata: ipodSongMetadata(song, coverOf(song)) };
    },
    save: (path) => Promise.reject(readOnly(path)),
    async openMedia(path): Promise<MediaHandle> {
      listed(path);
      const file = await drive.file(path);
      if (!file) throw new DOMException(`Not found: ${path}`, "NotFoundError");
      // Typed by extension: a slice is still the file on the drive, not read into memory.
      // An iPod's AAC songs (`.m4a`, which the app's formats do not list) as MPEG-4 audio.
      const type = audioMimeType(path) || (/\.m4[ab]$/i.test(path) ? "audio/mp4" : file.type);
      const url = URL.createObjectURL(file.slice(0, file.size, type));
      return {
        url,
        changed: async () => {
          const now = await drive.file(path);
          return !now || now.size !== file.size || now.lastModified !== file.lastModified;
        },
        release: () => URL.revokeObjectURL(url)
      };
    },
    close: () => undefined
  };
}
