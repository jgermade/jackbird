/**
 * Renaming tracks from their tags: a pattern of `%field%`s (mp3tag's,
 * foobar2000's and MusicBrainz Picard's syntax), the name it gives each
 * track, made safe for any file system, and a plan that says which names
 * clash. Only the file's name changes; it stays in its folder and keeps its
 * extension. See RECORD/2026-11-04.github-actions-workflows.WIP.md (22:00,
 * 22:12 and W5's plan).
 */

import type { Track, TrackMetadata } from "../types.ts";
import { emptyMetadata } from "./metadata.ts";
import { inferDiscNumber } from "./tracks.ts";

/** The fields a pattern can use. */
export const RENAME_FIELDS = ["title", "artist", "album", "album_artist", "year", "genre", "track", "disc", "composer", "comment", "filename"] as const;

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
  /**
   * The part of the path the pattern names, before and after: the file's name, and with `/` the
   * folders above it it names too (what the preview shows and compares).
   */
  shownFrom: string;
  shown: string;
  status: RenameStatus;
};

type Named = Pick<Track, "id" | "name" | "relativePath" | "metadata">;

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
    album_artist: track.metadata.albumArtist,
    year: track.metadata.year,
    genre: track.metadata.genre,
    track: number === null ? "" : String(number).padStart(width, "0"),
    disc: String(inferDiscNumber(track as Track)),
    composer: track.metadata.composer,
    comment: track.metadata.comment,
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
  // With `/`, the pattern names the folders above the file too, from the end of its path: those are
  // replaced (made when the file has fewer), and the folders above them stay.
  const segments = pattern.split("/");
  const named = segments.length - 1;
  const draft = tracks.map((track) => {
    const width = widths.get(folderOf(track.relativePath));
    const folders = track.relativePath.split("/").slice(0, -1);
    const kept = folders.slice(0, Math.max(0, folders.length - named));
    const made = segments.slice(0, -1).map((segment) => safeName(fillPattern(segment, track, width)));
    const base = safeName(fillPattern(segments[segments.length - 1], track, width));
    const name = base && made.every(Boolean) ? `${base}${extensionOf(track.name)}` : "";
    const to = [...kept, ...made, name].join("/");
    const shownFrom = track.relativePath.split("/").slice(-(named + 1)).join("/");
    const shown = name ? [...made, name].join("/") : "";
    return { track, name, to, shownFrom, shown };
  });
  const targets = new Map<string, number>();
  for (const one of draft) {
    if (one.name) targets.set(one.to.toLowerCase(), (targets.get(one.to.toLowerCase()) ?? 0) + 1);
  }
  const taken = new Map(libraryPaths.map((path) => [path.toLowerCase(), path]));
  return draft.map(({ track, name, to, shownFrom, shown }): RenamePlan => {
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
    return { trackId: track.id, from, to: name ? to : from, name, shownFrom, shown, status };
  });
}

// ---- the other way: tags from a file's name (and its folders) -------------------------------

/** The tags a pattern's fields set, read from a name. */
export type ReadTags = Partial<Record<"title" | "artist" | "album" | "albumArtist" | "year" | "genre" | "trackNumber" | "discNumber" | "composer" | "comment", string>>;

/** What reading a track's name would do: set tags (`ok`), nothing new (`same`), or the name does not match (`nomatch`). */
export type ReadStatus = "ok" | "same" | "nomatch";

export type ReadPlan = {
  trackId: string;
  /** The part of the path the pattern was matched against: the file's name, and as many folders above it as the pattern has. */
  from: string;
  tags: ReadTags;
  status: ReadStatus;
};

const DIGITS = new Set(["track", "disc", "year"]);
const TAG_OF: Record<string, keyof ReadTags | null> = {
  title: "title",
  artist: "artist",
  album: "album",
  album_artist: "albumArtist",
  year: "year",
  genre: "genre",
  track: "trackNumber",
  disc: "discNumber",
  composer: "composer",
  comment: "comment",
  filename: null
};

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A pattern as a regular expression over a path's tail, and the field each group reads; null for an empty pattern. */
export function patternReader(pattern: string): { regex: RegExp; fields: string[]; depth: number } | null {
  const trimmed = pattern.trim().replace(/^\/+|\/+$/g, "");
  if (!trimmed) return null;
  const fields: string[] = [];
  let source = "";
  let last = 0;
  for (const match of trimmed.matchAll(/%(\w+)%/g)) {
    source += escapeRegExp(trimmed.slice(last, match.index)).replace(/\//g, "\\/");
    const field = match[1].toLowerCase();
    if (field in TAG_OF) {
      fields.push(field);
      source += DIGITS.has(field) ? "\\s*(\\d+)\\s*" : "([^/]+?)";
    } else {
      // An unknown %word%: anything there, read as nothing.
      source += "[^/]+?";
    }
    last = (match.index ?? 0) + match[0].length;
  }
  source += escapeRegExp(trimmed.slice(last)).replace(/\//g, "\\/");
  return { regex: new RegExp(`^${source}$`, "u"), fields, depth: trimmed.split("/").length };
}

/** A number field as read ("03" gives "3"), keeping the total the track had ("3/12"). */
function withTotal(read: string, had: string): string {
  const number = String(Number(read));
  const total = had.match(/\/\s*(\d+)/);
  return total ? `${number}/${total[1]}` : number;
}

/** The path's tail a pattern `depth` segments deep reads: its last folders and the file's name, without its extension; null when it has not as many. */
export function readSubject(relativePath: string, depth: number): string | null {
  const parts = relativePath.split("/");
  if (parts.length < depth) return null;
  const tail = parts.slice(-depth);
  const name = tail[tail.length - 1];
  tail[tail.length - 1] = name.slice(0, name.length - extensionOf(name).length);
  return tail.join("/");
}

/** The tags a track's name gives by `pattern`; null when it does not match. */
export function readTags(pattern: string, track: Pick<Named, "relativePath" | "metadata">): ReadTags | null {
  const reader = patternReader(pattern);
  if (!reader) return null;
  const subject = readSubject(track.relativePath, reader.depth);
  if (subject === null) return null;
  const match = subject.match(reader.regex);
  if (!match) return null;
  const tags: ReadTags = {};
  reader.fields.forEach((field, index) => {
    const key = TAG_OF[field];
    const value = match[index + 1]?.trim() ?? "";
    // A field the pattern names twice: its first reading.
    if (!key || !value || key in tags) return;
    if (key === "trackNumber") tags.trackNumber = withTotal(value, track.metadata.trackNumber);
    else if (key === "discNumber") tags.discNumber = withTotal(value, track.metadata.discNumber);
    else tags[key] = value;
  });
  return tags;
}

/** What reading each track's name by `pattern` would set. */
export function planReads(tracks: readonly Named[], pattern: string): ReadPlan[] {
  const depth = patternReader(pattern)?.depth ?? 1;
  return tracks.map((track) => {
    const tags = readTags(pattern, track);
    const from = readSubject(track.relativePath, depth) ?? track.name;
    if (!tags || Object.keys(tags).length === 0) return { trackId: track.id, from, tags: {}, status: "nomatch" };
    const same = (Object.keys(tags) as (keyof ReadTags)[]).every((key) => track.metadata[key] === tags[key]);
    return { trackId: track.id, from, tags, status: same ? "same" : "ok" };
  });
}

// ---- typing a pattern: the fields offered after a % -------------------------------------------

/**
 * Whether the caret is in a field being typed: after a `%` that opens one (the `%`s before it, from
 * the start, are an even number: the pairs closed), with only a word's letters since. Its place and
 * what is typed of its name; null otherwise.
 */
export function fieldQuery(value: string, caret: number): { start: number; query: string } | null {
  const before = value.slice(0, caret);
  const start = before.lastIndexOf("%");
  if (start < 0) return null;
  const query = before.slice(start + 1);
  if (!/^\w*$/.test(query)) return null;
  const opened = (before.slice(0, start).match(/%/g)?.length ?? 0) % 2 === 0;
  return opened ? { start, query } : null;
}

/** The fields a typed beginning (`query`) can complete, in the fields' order. */
export function fieldsFor(query: string): string[] {
  const lower = query.toLowerCase();
  return RENAME_FIELDS.filter((field) => field.startsWith(lower));
}

/**
 * The value with the field being typed at `caret` completed as `%field%` (a closing `%` and a name's
 * rest after the caret replaced too), and where the caret goes: after it.
 */
export function completeField(value: string, caret: number, field: string): { value: string; caret: number } {
  const at = fieldQuery(value, caret);
  if (!at) return { value, caret };
  const rest = value.slice(caret).match(/^\w*%?/)?.[0] ?? "";
  const token = `%${field}%`;
  return { value: value.slice(0, at.start) + token + value.slice(caret + rest.length), caret: at.start + token.length };
}

/** The names a file's tags are guessed from before they are read (the first that matches). */
const GUESSES = ["%track% - %title%", "%track%. %title%", "%track% %title%", "%artist% - %title%"] as const;

/**
 * What a file's name says of its tags, shown until they are read (a folder opened with no
 * `.meta/`): its number and title, or its artist and title, by the first of `GUESSES` that matches;
 * else its name without the extension as its title. Only the name: a folder (`Music/mp3/`) is no
 * artist or album.
 */
export function inferredMetadata(relativePath: string): TrackMetadata {
  const metadata = emptyMetadata();
  const track = { relativePath, metadata };
  for (const pattern of GUESSES) {
    const read = readTags(pattern, track);
    if (read?.title) return { ...metadata, ...read };
  }
  return { ...metadata, title: readSubject(relativePath, 1) ?? relativePath };
}
