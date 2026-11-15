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
