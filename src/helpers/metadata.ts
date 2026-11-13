import type { EditableMetadata, Track, TrackMetadata } from "../types.ts";

/** Which fields differ across a set of tracks. */
export type VariedFields = Record<keyof TrackMetadata, boolean>;

/** A text field of the tags (every field but the cover). */
export type TextField = Exclude<keyof TrackMetadata, "coverDataUrl">;

/** The text fields, the six the tags started with first. */
export const TEXT_FIELDS: readonly TextField[] = ["title", "artist", "album", "year", "genre", "trackNumber", "discNumber", "albumArtist", "compilation"];

/**
 * The fields added after the first six: a library read before them (in `.meta/`, a service's
 * catalogue) does not have them, and their tags are read again (`readsEveryField`).
 */
export const LATER_FIELDS: readonly TextField[] = ["discNumber", "albumArtist", "compilation"];

/** Metadata with every field empty and no cover. */
export function emptyMetadata(): TrackMetadata {
  return {
    title: "",
    artist: "",
    album: "",
    year: "",
    genre: "",
    trackNumber: "",
    discNumber: "",
    albumArtist: "",
    compilation: "",
    coverDataUrl: null
  };
}

/** Whether metadata was read with every field there is now: kept before some came, it was not. */
export function readsEveryField(metadata: Partial<TrackMetadata>): boolean {
  return LATER_FIELDS.every((field) => typeof metadata[field] === "string");
}

/** Metadata kept before some fields came, with those empty. */
export function withEveryField(metadata: Partial<TrackMetadata>): TrackMetadata {
  return { ...emptyMetadata(), ...metadata };
}

/** Whether the tags mark a compilation: iTunes' and Vorbis' "1" (a "0" or anything else does not). */
export function isCompilation(metadata: Pick<TrackMetadata, "compilation">): boolean {
  return metadata.compilation.trim() === "1";
}

/**
 * The values a set of tracks share, for a batch editor: a field that differs
 * between any two tracks comes back empty (and the cover `null`).
 */
export function computeCommonMetadata(tracks: Track[]): EditableMetadata {
  if (tracks.length === 0) {
    return emptyMetadata();
  }

  const result: EditableMetadata = { ...tracks[0].metadata };
  for (const { metadata } of tracks.slice(1)) {
    for (const field of TEXT_FIELDS) {
      if (metadata[field] !== result[field]) result[field] = "";
    }
    if (metadata.coverDataUrl !== result.coverDataUrl) result.coverDataUrl = null;
  }
  return result;
}

/**
 * Which fields differ from the first track's, so a batch save knows which
 * empty fields mean "keep each track's own value". One track or none varies
 * in nothing.
 */
export function getVariedFields(tracks: Track[]): VariedFields {
  const first = tracks[0]?.metadata;
  const differs = (field: keyof TrackMetadata): boolean =>
    tracks.length > 1 && tracks.some((track) => track.metadata[field] !== first[field]);

  const varied = { coverDataUrl: differs("coverDataUrl") } as VariedFields;
  for (const field of TEXT_FIELDS) varied[field] = differs(field);
  return varied;
}

/**
 * One track's tags after a batch edit: the draft's, except that a field the
 * selection varied in and the draft left empty keeps the track's own value,
 * unless that field is `confirmed` (the form's "Override" box ticked on it): then
 * the empty value is written, clearing it on every track. A varied cover the
 * draft left unset keeps the track's own too. With one track, nothing varies
 * and the draft is taken whole.
 */
export function mergeDraft(original: TrackMetadata, draft: EditableMetadata, varied: VariedFields, confirmed: readonly string[] = []): TrackMetadata {
  const merged = {
    coverDataUrl: varied.coverDataUrl && draft.coverDataUrl === null ? original.coverDataUrl : draft.coverDataUrl
  } as TrackMetadata;
  for (const field of TEXT_FIELDS) {
    merged[field] = varied[field] && !draft[field] && !confirmed.includes(field) ? original[field] : draft[field];
  }
  return merged;
}
