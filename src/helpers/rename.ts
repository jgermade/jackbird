/**
 * Renaming tracks from their tags: a pattern of `%field%`s (mp3tag's,
 * foobar2000's and MusicBrainz Picard's syntax), the name it gives each
 * track, made safe for any file system, and a plan that says which names
 * clash. Only the file's name changes; it stays in its folder and keeps its
 * extension. See RECORD/2026-11-04.github-actions-workflows.WIP.md (22:00,
 * 22:12 and W5's plan).
 */

import type { Mp3Track } from "../types.ts";
import { inferDiscNumber } from "./tracks.ts";

/** The fields a pattern can use. */
export const RENAME_FIELDS = ["title", "artist", "album", "year", "genre", "track", "disc", "filename"] as const;

/** Ready-made patterns; the first is the default. */
export const RENAME_PRESETS = ["%track% - %title%", "%artist% - %title%", "%track%. %artist% - %title%", "%disc%-%track% %title%"] as const;

/** What a track's rename would do: `ok`, nothing (`same`), no name left (`empty`), or a name taken (`clash`). */
export type RenameStatus = "ok" | "same" | "empty" | "clash";

export type RenamePlan = {
  trackId: string;
  from: string;
  to: string;
  /** The new file name, extension included. */
  name: string;
  status: RenameStatus;
};

type Named = Pick<Mp3Track, "id" | "name" | "relativePath" | "metadata">;

const folderOf = (path: string): string => path.slice(0, path.lastIndexOf("/") + 1);

/** A name's extension, with its dot (".mp3"); "" without one. */
function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot) : "";
}

/** The number in a track field ("3/12" gives 3), or null. */
function trackNumber(value: string): number | null {
  const match = value.match(/\d+/);
  return match ? Number(match[0]) : null;
}

/** The total in a track field ("3/12" gives 12), or null. */
function trackTotal(value: string): number | null {
  const match = value.match(/\/\s*(\d+)/);
  return match ? Number(match[1]) : null;
}

/**
 * How many digits `%track%` takes in each folder: the most of its tracks'
 * totals ("3/12": 2) and their largest number, and at least two, so names
 * sort as the tracks play.
 */
export function trackWidths(tracks: readonly Named[]): Map<string, number> {
  const widths = new Map<string, number>();
  for (const track of tracks) {
    const folder = folderOf(track.relativePath);
    const largest = Math.max(trackTotal(track.metadata.trackNumber) ?? 0, trackNumber(track.metadata.trackNumber) ?? 0);
    widths.set(folder, Math.max(widths.get(folder) ?? 2, String(largest).length));
  }
  return widths;
}

/** A track's name by `pattern`, before it is made safe; an unknown `%word%` stays as typed. */
export function fillPattern(pattern: string, track: Named, width = 2): string {
  const number = trackNumber(track.metadata.trackNumber);
  const values: Record<string, string> = {
    title: track.metadata.title,
    artist: track.metadata.artist,
    album: track.metadata.album,
    year: track.metadata.year,
    genre: track.metadata.genre,
    track: number === null ? "" : String(number).padStart(width, "0"),
    disc: String(inferDiscNumber(track as Mp3Track)),
    filename: track.name.slice(0, track.name.length - extensionOf(track.name).length)
  };
  return pattern.replace(/%(\w+)%/g, (whole, field: string) => (field.toLowerCase() in values ? values[field.toLowerCase()] : whole));
}

/**
 * A name any file system takes: `\ / : * ? " < > |` and control characters
 * become `_`, the spaces around it go, and so do trailing dots (Windows
 * drops them).
 */
export function safeName(name: string): string {
  // eslint-disable-next-line no-control-regex
  return name.replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, "_").trim().replace(/[.\s]+$/, "");
}

/**
 * What renaming `tracks` by `pattern` would do. `libraryPaths` are every
 * track's path in the root; a new name clashes with another of the batch, or
 * with a track of the library that is not the one renamed, compared without
 * case (as Windows and macOS compare names).
 */
export function planRenames(tracks: readonly Named[], pattern: string, libraryPaths: readonly string[]): RenamePlan[] {
  const widths = trackWidths(tracks);
  const draft = tracks.map((track) => {
    const folder = folderOf(track.relativePath);
    const base = safeName(fillPattern(pattern, track, widths.get(folder)));
    const name = base ? `${base}${extensionOf(track.name)}` : "";
    return { track, folder, name, to: `${folder}${name}` };
  });
  const targets = new Map<string, number>();
  for (const one of draft) {
    if (one.name) targets.set(one.to.toLowerCase(), (targets.get(one.to.toLowerCase()) ?? 0) + 1);
  }
  const taken = new Map(libraryPaths.map((path) => [path.toLowerCase(), path]));
  return draft.map(({ track, name, to }): RenamePlan => {
    const from = track.relativePath;
    const key = to.toLowerCase();
    let status: RenameStatus = "ok";
    if (!name) {
      status = "empty";
    } else if (to === from) {
      status = "same";
    } else if ((targets.get(key) ?? 0) > 1 || (taken.has(key) && key !== from.toLowerCase())) {
      status = "clash";
    }
    return { trackId: track.id, from, to: name ? to : from, name, status };
  });
}
