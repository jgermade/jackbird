// Songs dropped on the library (RECORD/2026-11-03.deck-design-system.WIP.md, 2026-11-19, plan H):
// where each lands, by a pattern of `%field%`s and `/`s (the rename tab's syntax and fields:
// helpers/rename.ts), the tags it needs that it lacks, and its tags tidied before it lands.

import type { TrackMetadata } from "../types.ts";
import { fillPattern, readTags, safeName, type ReadTags } from "./rename.ts";

/** The pattern a dropped song's path is made by, unless the person chose another. */
export const DEFAULT_DROP_PATTERN = "%artist%/%year% - %album%/%track% %title%";

/** The pattern names are read from, for a song missing tags, unless the person chose another. */
export const DEFAULT_READ_PATTERN = "%artist% - %album%/%track% %title%";

/** A field of a pattern and the tag it is. */
const TAG_OF: Record<string, keyof ReadTags> = {
  title: "title",
  artist: "artist",
  album: "album",
  year: "year",
  genre: "genre",
  track: "trackNumber",
  disc: "discNumber",
  composer: "composer",
  comment: "comment"
};

export type DropTag = keyof ReadTags;

/** The tags a pattern uses, in its order, once each (`%filename%` and unknown words are none). */
export function patternTags(pattern: string): DropTag[] {
  const tags: DropTag[] = [];
  for (const match of pattern.matchAll(/%(\w+)%/g)) {
    const tag = TAG_OF[match[1].toLowerCase()];
    if (tag && !tags.includes(tag)) tags.push(tag);
  }
  return tags;
}

/** The tags `pattern` uses that a song lacks. */
export function missingTags(pattern: string, metadata: TrackMetadata): DropTag[] {
  return patternTags(pattern).filter((tag) => !String(metadata[tag] ?? "").trim());
}

const TEXT: readonly (keyof TrackMetadata)[] = ["title", "artist", "album", "year", "genre", "trackNumber", "discNumber", "albumArtist", "composer", "comment"];

/** A song's tags tidied: spaces trimmed and runs of them made one; the year cut to its four digits (`2010-05-03` → `2010`). */
export function tidyTags(metadata: TrackMetadata): TrackMetadata {
  const tidy = { ...metadata };
  for (const key of TEXT) tidy[key] = String(tidy[key] ?? "").replace(/\s+/g, " ").trim();
  const year = /\b(\d{4})\b/.exec(String(tidy.year))?.[1];
  if (year) tidy.year = year;
  return tidy;
}

/** Whether two songs' tags differ in a field the drop may change. */
export function tagsChanged(before: TrackMetadata, after: TrackMetadata): boolean {
  return TEXT.some((key) => before[key] !== after[key]);
}

/** What a song's dropped path says of the tags it lacks, by `pattern` (only those it lacks). */
export function recoverTags(pattern: string, relativePath: string, metadata: TrackMetadata): ReadTags {
  const read = readTags(pattern, { relativePath, metadata }) ?? {};
  const filled: ReadTags = {};
  for (const [tag, value] of Object.entries(read) as [DropTag, string][]) {
    if (value && !String(metadata[tag] ?? "").trim()) filled[tag] = value;
  }
  return filled;
}

/** A part of a path whose fields were empty, tidied: the separators left at its ends, or doubled, go. */
function tidyPart(part: string): string {
  return part
    .replace(/\s*[-–—]\s*(?:[-–—]\s*)+/g, " - ")
    .replace(/^[\s\-–—_.,]+|[\s\-–—_,]+$/g, "")
    .replace(/\(\s*\)|\[\s*\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Where a dropped song lands, by `pattern`: each part filled from its tags, tidied and made safe
 * for any file system, empty ones left out; its extension kept. With no name left, its own.
 */
export function dropPath(pattern: string, name: string, metadata: TrackMetadata): string {
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? name.slice(dot) : "";
  const track = { id: "", name, relativePath: name, metadata };
  const parts = pattern
    .split("/")
    .map((part) => safeName(tidyPart(fillPattern(part, track))))
    .filter((part) => part.length > 0);
  const file = parts.pop();
  if (!file) return name;
  return [...parts, `${file}${extension}`].join("/");
}

/** A path not among `taken` (compared without case): itself, or with ` (2)`, ` (3)`… before its extension. */
export function freePath(path: string, taken: ReadonlySet<string>): string {
  if (!taken.has(path.toLowerCase())) return path;
  const dot = path.lastIndexOf(".");
  const slash = path.lastIndexOf("/");
  const [stem, extension] = dot > slash + 1 ? [path.slice(0, dot), path.slice(dot)] : [path, ""];
  for (let n = 2; ; n += 1) {
    const candidate = `${stem} (${n})${extension}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}
