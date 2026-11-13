/**
 * Covers as jackbird keeps them, references to a picture kept once (in `TrackMetadata` and in
 * `.meta/`) or data URLs (one just chosen, or as an older `.meta/` holds them), and as the tag
 * engine takes them, bytes and a MIME type. See
 * RECORD/2026-08-11.musikmatch-rust-migration.WIP.md (2026-11-07 20:16, E2-D7).
 */
import type { TrackMetadata } from "../types.ts";
import type { WireCover, WireEdit } from "./tagwire.ts";

/** How many bytes go to `String.fromCharCode` at once: well under any engine's argument limit. */
const CHUNK = 0x8000;

/** A picture as a data URL. */
export function coverToDataUrl(cover: WireCover): string {
  let binary = "";
  for (let at = 0; at < cover.data.length; at += CHUNK) {
    binary += String.fromCharCode(...cover.data.subarray(at, at + CHUNK));
  }
  return `data:${cover.mime || "image/jpeg"};base64,${btoa(binary)}`;
}

/** A data URL's picture, or null when it is not a base64 data URL. */
export function dataUrlToCover(url: string): WireCover | null {
  const match = /^data:([^;,]*)(?:;[^;,]*)*;base64,(.*)$/s.exec(url);
  if (!match) {
    return null;
  }
  const data = fromBase64(match[2]);
  return data ? { mime: match[1] || "image/jpeg", data } : null;
}

/** Bytes from base64, or null when it is not base64. */
export function fromBase64(text: string): Uint8Array | null {
  let binary: string;
  try {
    binary = atob(text);
  } catch {
    return null;
  }
  const data = new Uint8Array(binary.length);
  for (let at = 0; at < binary.length; at += 1) {
    data[at] = binary.charCodeAt(at);
  }
  return data;
}

/**
 * A cover kept once (RECORD/2026-11-03.deck-design-system.WIP.md, 2026-11-14): the library holds
 * a reference to it, `jackbird-cover:<name>`, in place of the picture itself; the picture is in
 * memory once (lib/covers.ts) and in the folder's `.meta/covers/<name>`. The name is made from
 * the bytes (two FNV-1a hashes and the length), the same as crates/api's `cover_name`, so the same
 * picture has one name whoever read it; and its type's extension, so the file says what it is.
 */
export const COVER_REF = "jackbird-cover:";

/** Two 32-bit FNV-1a hashes of the bytes, one from the standard offset and one from another. */
function fnv(data: Uint8Array): [number, number] {
  let one = 0x811c9dc5;
  let two = 0x01000193 ^ 0x5bd1e995;
  for (let at = 0; at < data.length; at += 1) {
    one = Math.imul(one ^ data[at], 0x01000193) >>> 0;
    two = Math.imul(two ^ data[at], 0x01000193) >>> 0;
  }
  return [one, two];
}

const EXTENSIONS: Record<string, string> = { "image/jpeg": "jpg", "image/jpg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp", "image/bmp": "bmp" };

/** A picture's name: its hashes and length in hex, and its type's extension. */
export function coverName(cover: WireCover): string {
  const [one, two] = fnv(cover.data);
  const hex = (value: number) => value.toString(16).padStart(8, "0");
  return `${hex(one)}${hex(two)}-${cover.data.length.toString(16)}.${EXTENSIONS[(cover.mime || "image/jpeg").toLowerCase()] ?? "img"}`;
}

/** The type a cover's name says, by its extension. */
export function coverMime(name: string): string {
  const extension = name.slice(name.lastIndexOf(".") + 1);
  return Object.entries(EXTENSIONS).find(([, one]) => one === extension)?.[0] ?? "image/jpeg";
}

/** A reference to a cover by its name. */
export const coverRef = (name: string): string => COVER_REF + name;

/** The name a reference points to, or null for anything else (a data URL, nothing). */
export function refName(value: string | null | undefined): string | null {
  if (!value?.startsWith(COVER_REF)) return null;
  const name = value.slice(COVER_REF.length);
  // Only a name as coverName makes it: never a path.
  return /^[0-9a-f]{16}-[0-9a-f]+\.[a-z]+$/.test(name) ? name : null;
}

/**
 * The edit that saves `metadata` over a track whose tags were `previous`:
 * the first six fields (the engine leaves alone those that do not change, and
 * removes the empty ones), and the disc, album artist and compilation when
 * they change; the cover kept when it is the track's own, removed when
 * the form has none, else set.
 */
export function editFor(previous: TrackMetadata, metadata: TrackMetadata): WireEdit {
  const fields: WireEdit["fields"] = {
    title: metadata.title,
    artist: metadata.artist,
    album: metadata.album,
    year: metadata.year,
    genre: metadata.genre,
    track: metadata.trackNumber
  };
  // The fields that came later, only when they change: a library read before them holds them
  // empty, which must not empty the file's (crates/api's edit_for does the same).
  const later = { disc: "discNumber", albumArtist: "albumArtist", compilation: "compilation" } as const;
  for (const [wire, field] of Object.entries(later) as [keyof typeof later, (typeof later)[keyof typeof later]][]) {
    if (metadata[field] !== previous[field]) fields[wire] = metadata[field];
  }
  if (metadata.coverDataUrl === previous.coverDataUrl) {
    return { fields, cover: { keep: true } };
  }
  if (metadata.coverDataUrl === null) {
    return { fields, cover: { remove: true } };
  }
  const cover = dataUrlToCover(metadata.coverDataUrl);
  return { fields, cover: cover ? { set: cover } : { keep: true } };
}
