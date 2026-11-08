/**
 * What jackbird does to a playlist's entries and files, apart from reading
 * and writing M3U (m3u.ts): which files are playlists, their text, where a
 * new one goes, the entry for a track, and an entry moved, taken out, or
 * following a rename. See RECORD/2026-11-04.github-actions-workflows.WIP.md
 * (22:00, 22:12 and W8's plan).
 */

import type { Track, Playlist, PlaylistEntry } from "../types.ts";
import { safeName } from "./rename.ts";

/** The folder at the root where a new playlist is written. */
export const PLAYLIST_FOLDER = "Playlists";

/** Whether a file is a playlist jackbird reads: `.m3u8` or `.m3u`. */
export function isPlaylistFile(path: string): boolean {
  return /\.m3u8?$/i.test(path);
}

/**
 * A playlist file's text: `.m3u8` is UTF-8; a `.m3u` is read as UTF-8 when
 * it is valid UTF-8, else as Windows-1252, what players wrote before.
 */
export function decodePlaylist(bytes: Uint8Array, path: string): string {
  if (/\.m3u8$/i.test(path)) {
    return new TextDecoder("utf-8").decode(bytes);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

/** Where a new playlist named `name` goes: `Playlists/<name>.m3u8`, the name made safe as a file's; null when nothing is left of it. */
export function newPlaylistPath(name: string): string | null {
  const safe = safeName(name);
  return safe ? `${PLAYLIST_FOLDER}/${safe}.m3u8` : null;
}

/** Whether `path` is one of `taken`, compared without case (as Windows and macOS compare names). */
export function pathTaken(path: string, taken: readonly string[]): boolean {
  const key = path.toLowerCase();
  return taken.some((one) => one.toLowerCase() === key);
}

/** A track's entry: its path, and "Artist - Title" (or the title alone) for `#EXTINF`. */
export function entryFor(track: Pick<Track, "relativePath" | "metadata">): PlaylistEntry {
  const title = track.metadata.title.trim();
  const artist = track.metadata.artist.trim();
  return { path: track.relativePath, raw: track.relativePath, title: title ? (artist ? `${artist} - ${title}` : title) : undefined };
}

/** `entries` with the one at `from` moved to `to`; as they were when either is out of range. */
export function moveEntry(entries: readonly PlaylistEntry[], from: number, to: number): PlaylistEntry[] {
  if (from === to || from < 0 || to < 0 || from >= entries.length || to >= entries.length) {
    return [...entries];
  }
  const next = [...entries];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/** `entries` without the one at `index`. */
export function withoutEntry(entries: readonly PlaylistEntry[], index: number): PlaylistEntry[] {
  return entries.filter((_, at) => at !== index);
}

/** `entries` following renamed files (old path to new); null when none of them was renamed. */
export function renamedEntries(entries: readonly PlaylistEntry[], renames: ReadonlyMap<string, string>): PlaylistEntry[] | null {
  let changed = false;
  const next = entries.map((entry) => {
    const to = entry.path ? renames.get(entry.path) : undefined;
    if (!to) {
      return entry;
    }
    changed = true;
    return { ...entry, path: to, raw: to };
  });
  return changed ? next : null;
}

/** `playlists` with `playlist` in place of the one at its path, or added. */
export function withPlaylist(playlists: readonly Playlist[], playlist: Playlist): Playlist[] {
  return playlists.some((one) => one.path === playlist.path)
    ? playlists.map((one) => (one.path === playlist.path ? playlist : one))
    : [...playlists, playlist];
}
