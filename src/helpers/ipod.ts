/**
 * Sending songs to an iPod, worked out before anything is sent: which files can
 * go (MP3s: jackbird writes no other format to an iPod yet), and which look
 * like songs the iPod has already (the same title and artist, case, accents and
 * punctuation aside), so that a duplicate is the person's choice and not a
 * surprise. See RECORD/2026-11-14.ipod-sync.WIP.md (the panel). And an iPod
 * opened in a browser (W3): where its databases are, its covers' names, its
 * songs' fields.
 */

import type { TrackMetadata } from "../types.ts";
import { coverRef } from "./cover.ts";

/** A song as compared: its title and artist. */
export type SongName = { title: string; artist: string };

/** A name in lower case, without accents, spaces or punctuation: "Don’t Stop" and "dont stop" match. */
export function folded(name: string): string {
  return name
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
}

/** The key two songs match by. */
export function songKey(song: SongName): string {
  return `${folded(song.title)}\u0000${folded(song.artist)}`;
}

/**
 * The positions of the `candidates` that look like songs already in `existing`
 * (or like an earlier candidate: one file sent twice). A song with no title is
 * never a duplicate: there is nothing to tell it by.
 */
export function likelyDuplicates(candidates: SongName[], existing: SongName[]): number[] {
  const seen = new Set(existing.filter((song) => folded(song.title)).map(songKey));
  const out: number[] = [];
  candidates.forEach((song, index) => {
    if (!folded(song.title)) return;
    const key = songKey(song);
    if (seen.has(key)) out.push(index);
    seen.add(key);
  });
  return out;
}

/** Whether a file can be sent to an iPod: an MP3. */
export function isSendable(path: string): boolean {
  return path.toLowerCase().endsWith(".mp3");
}

/**
 * An iPod's databases, where its firmware keeps them, the one read first first: the nano 5G to 7G
 * keep an `iTunesCDB` (compressed), the others an `iTunesDB`. A folder holding either is an iPod.
 */
export const IPOD_DATABASES = ["iPod_Control/iTunes/iTunesCDB", "iPod_Control/iTunes/iTunesDB"] as const;

/** Where an iPod keeps its covers' database and image files. */
export const IPOD_ARTWORK = "iPod_Control/Artwork";

/**
 * The name a cover of image `id` on the iPod at `root` (its mount point, or its drive's name in a
 * browser) goes by, as the desktop app names it (`cover_name` in src-tauri/src/ipod.rs): `root`'s
 * UTF-8 hashed twice (FNV-1a, two seeds), a dash, the ID in hex, ".png". Unique to that iPod, and
 * shaped as helpers/cover.ts's names are.
 */
export function ipodCoverName(root: string, id: number): string {
  const bytes = new TextEncoder().encode(root);
  const hash = (seed: number): string => {
    let h = seed >>> 0;
    for (const byte of bytes) h = Math.imul(h ^ byte, 0x01000193) >>> 0;
    return h.toString(16).padStart(8, "0");
  };
  return `${hash(0x811c9dc5)}${hash((0x01000193 ^ 0x69706f64) >>> 0)}-${id.toString(16)}.png`;
}

/** A song of an iPod's database, as listed (lib/ipod-db/wasm.ts). */
export type ListedSong = {
  title: string;
  artist: string;
  album: string;
  albumArtist: string;
  genre: string;
  year: string;
  trackNumber: string;
  discNumber: string;
  compilation: boolean;
  /** Beats per minute, 0 for none. */
  bpm?: number;
};

/** A listed song's fields as the library holds them, its cover by reference (`cover`, a name) when it has one. */
export function ipodSongMetadata(song: ListedSong, cover: string | null): TrackMetadata {
  return {
    title: song.title,
    artist: song.artist,
    album: song.album,
    year: song.year,
    genre: song.genre,
    trackNumber: song.trackNumber,
    discNumber: song.discNumber,
    albumArtist: song.albumArtist,
    compilation: song.compilation ? "1" : "",
    // The iPod's listing in the browser carries none of these (the desktop app's carries the composer).
    composer: "",
    comment: "",
    lyrics: "",
    bpm: song.bpm ? String(song.bpm) : "",
    coverDataUrl: cover === null ? null : coverRef(cover)
  };
}

/** `items` in groups of `size` (the last one shorter), in order. */
export function inGroups<T>(items: readonly T[], size: number): T[][] {
  const step = Math.max(1, Math.floor(size));
  const out: T[][] = [];
  for (let at = 0; at < items.length; at += step) out.push(items.slice(at, at + step));
  return out;
}

/** The row key that shows the iPod's own sheet in Details (W5): no row of the tree has it. */
export const IPOD_ROW = "@ipod";

/** What the model is known by: the locale key of its name (`ipod.model.*`). */
export type IpodModelKey = "nano7" | "nano67" | "nano5" | "hash58" | "older" | "unknown";

/** What an iPod's device facts and database tell of its model. */
export type ModelClues = { familyId: string | null; checksum: number | null };

/**
 * The iPod's model, as far as its files tell: `SysInfoExtended`'s `FamilyID` where it is known (18,
 * the owner's nano 7G), else the family its database's checksum scheme points to (hashAB: the nano
 * 6G or 7G; hash72: the nano 5G; hash58: the classic, the nano 3G or 4G; none: the video, the nano
 * 1G or 2G).
 */
export function ipodModel(clues: ModelClues): IpodModelKey {
  if (clues.familyId?.trim() === "18") return "nano7";
  switch (clues.checksum) {
    case 3:
      return "nano67";
    case 2:
      return "nano5";
    case 1:
      return "hash58";
    case 0:
      return "older";
    default:
      return "unknown";
  }
}

/** What a drive's space is: known where the system said (the desktop app), else only the music's. */
export type IpodUsage = { total: number | null; free: number | null; used: number | null; fraction: number | null; music: number };

/** The space of an iPod's drive (`total` and `free`, null where unknown) and its music's bytes. */
export function ipodUsage(total: number | null, free: number | null, music: number): IpodUsage {
  if (total === null || free === null || total <= 0) return { total: null, free: null, used: null, fraction: null, music };
  const used = Math.max(0, total - free);
  return { total, free, used, fraction: Math.min(1, used / total), music };
}

/** A library's songs, albums, artists and bytes. An album is told by its artist and title. */
export function libraryCounts(tracks: readonly { size: number; metadata: { album: string; artist: string; albumArtist: string } }[]): {
  songs: number;
  albums: number;
  artists: number;
  bytes: number;
} {
  const albums = new Set<string>();
  const artists = new Set<string>();
  let bytes = 0;
  for (const { size, metadata } of tracks) {
    bytes += size;
    const artist = (metadata.albumArtist || metadata.artist).trim();
    if (metadata.artist.trim()) artists.add(folded(metadata.artist));
    if (metadata.album.trim()) albums.add(`${folded(artist)}\u0000${folded(metadata.album)}`);
  }
  return { songs: tracks.length, albums: albums.size, artists: artists.size, bytes };
}

/** A drive's size as its system shows it: decimal units, one decimal ("15.8 GB", "980 MB"), in `language`. */
export function formatDriveSize(bytes: number, language: string): string {
  const [value, unit] = bytes >= 1e9 ? [bytes / 1e9, "GB"] : bytes >= 1e6 ? [bytes / 1e6, "MB"] : [bytes / 1e3, "KB"];
  return `${new Intl.NumberFormat(language, { maximumFractionDigits: 1 }).format(value)} ${unit}`;
}

/** The kinds of content an iPod's space bar tells apart (W5b), in its order. */
export type ContentKind = "music" | "covers" | "photos" | "rockbox" | "other";

/** A part of the space bar: a kind and its bytes. */
export type UsagePart = { kind: ContentKind; bytes: number };

/**
 * The parts of an iPod's used space, in the bar's order: its music, covers, photos and Rockbox
 * (each as known, unknown ones as 0), then "other", what is used and is none of them (never below
 * 0). Parts of 0 bytes are left out. None when the drive's use is unknown.
 */
export function usageParts(usage: IpodUsage, content: { artwork: number | null; photos: number | null; rockbox: number | null }): UsagePart[] {
  if (usage.used === null) return [];
  const known: UsagePart[] = [
    { kind: "music", bytes: usage.music },
    { kind: "covers", bytes: content.artwork ?? 0 },
    { kind: "photos", bytes: content.photos ?? 0 },
    { kind: "rockbox", bytes: content.rockbox ?? 0 }
  ];
  const told = known.reduce((sum, part) => sum + part.bytes, 0);
  return [...known, { kind: "other" as const, bytes: Math.max(0, usage.used - told) }].filter((part) => part.bytes > 0);
}

/** Which library of an iPod a root shows (W7): Apple's database, or the drive as Rockbox lists it. */
export type IpodLibrary = "apple" | "rockbox";

/**
 * The files of an iPod's drive that Rockbox's library holds (W7), as its database lists them: every
 * file, but none under a folder that holds a `database.ignore` (a folder below it that holds a
 * `database.unignore` counts again), and none whose path has a part starting with "." (Rockbox's
 * own `.rockbox/`, the system's `.Trashes` and `.Spotlight-V100`, macOS's `._` files beside each
 * file on a FAT drive). Nor Apple's songs under `iPod_Control/`, which the Apple library shows (the
 * owner's ask, 2026-11-16): each library its own music. Which of them are tracks is the app's own
 * rule (by extension).
 */
export function rockboxLibraryPaths(paths: readonly string[]): string[] {
  const marked = (name: string): Set<string> =>
    new Set(paths.filter((path) => path === name || path.endsWith(`/${name}`)).map((path) => path.slice(0, Math.max(0, path.length - name.length - 1))));
  const ignore = marked("database.ignore");
  const unignore = marked("database.unignore");
  const ignored = (path: string): boolean => {
    const parts = path.split("/").slice(0, -1);
    let out = false;
    for (let depth = 0; depth <= parts.length; depth += 1) {
      const folder = parts.slice(0, depth).join("/");
      if (ignore.has(folder)) out = true;
      if (unignore.has(folder)) out = false;
    }
    return out;
  };
  const apple = (path: string): boolean => path.split("/")[0].toLowerCase() === "ipod_control";
  return paths.filter((path) => !apple(path) && !path.split("/").some((part) => part.startsWith(".")) && !ignored(path));
}
