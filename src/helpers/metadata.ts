import type { EditableMetadata, Mp3Track, TrackMetadata } from "../types.ts";

/** Which fields differ across a set of tracks. */
export type VariedFields = Record<keyof TrackMetadata, boolean>;

/** Metadata with every field empty and no cover. */
export function emptyMetadata(): TrackMetadata {
  return {
    title: "",
    artist: "",
    album: "",
    year: "",
    genre: "",
    trackNumber: "",
    coverDataUrl: null
  };
}

/**
 * The values a set of tracks share, for a batch editor: a field that differs
 * between any two tracks comes back empty (and the cover `null`).
 */
export function computeCommonMetadata(tracks: Mp3Track[]): EditableMetadata {
  if (tracks.length === 0) {
    return emptyMetadata();
  }

  const result: EditableMetadata = { ...tracks[0].metadata };
  for (const { metadata } of tracks.slice(1)) {
    if (metadata.title !== result.title) result.title = "";
    if (metadata.artist !== result.artist) result.artist = "";
    if (metadata.album !== result.album) result.album = "";
    if (metadata.year !== result.year) result.year = "";
    if (metadata.genre !== result.genre) result.genre = "";
    if (metadata.trackNumber !== result.trackNumber) result.trackNumber = "";
    if (metadata.coverDataUrl !== result.coverDataUrl) result.coverDataUrl = null;
  }
  return result;
}

/**
 * Which fields differ from the first track's, so a batch save knows which
 * empty fields mean "keep each track's own value". One track or none varies
 * in nothing.
 */
export function getVariedFields(tracks: Mp3Track[]): VariedFields {
  const first = tracks[0]?.metadata;
  const differs = (field: keyof TrackMetadata): boolean =>
    tracks.length > 1 && tracks.some((track) => track.metadata[field] !== first[field]);

  return {
    title: differs("title"),
    artist: differs("artist"),
    album: differs("album"),
    year: differs("year"),
    genre: differs("genre"),
    trackNumber: differs("trackNumber"),
    coverDataUrl: differs("coverDataUrl")
  };
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
  const text = (field: Exclude<keyof TrackMetadata, "coverDataUrl">): string =>
    varied[field] && !draft[field] && !confirmed.includes(field) ? original[field] : draft[field];

  return {
    title: text("title"),
    artist: text("artist"),
    album: text("album"),
    year: text("year"),
    genre: text("genre"),
    trackNumber: text("trackNumber"),
    coverDataUrl: varied.coverDataUrl && draft.coverDataUrl === null ? original.coverDataUrl : draft.coverDataUrl
  };
}
