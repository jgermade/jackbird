/**
 * Covers as jackbird keeps them, data URLs (in `TrackMetadata` and in
 * `.meta/`), and as the tag engine takes them, bytes and a MIME type. See
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
  let binary: string;
  try {
    binary = atob(match[2]);
  } catch {
    return null;
  }
  const data = new Uint8Array(binary.length);
  for (let at = 0; at < binary.length; at += 1) {
    data[at] = binary.charCodeAt(at);
  }
  return { mime: match[1] || "image/jpeg", data };
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
