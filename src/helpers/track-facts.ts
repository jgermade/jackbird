/**
 * What a track's information shows, in groups: its quality, its tags, where it is, and its file.
 * One list for the selection dialog's Info tab (all groups in a row) and the track's own info
 * dialog (each group under its heading), so the two cannot drift apart. See
 * RECORD/2026-11-03.deck-design-system.WIP.md (2026-11-17).
 */

import type { IdField, Track } from "../types.ts";
import { formatBytes, formatDuration } from "./format.ts";
import { codecLabel } from "./formats.ts";

/** The texts the facts are labelled with (src/lib/locales/en.ts). */
export type FactKey =
  | "common.none" | "common.yes" | "common.no"
  | "field.title" | "field.artist" | "field.album" | "field.albumArtist" | "field.track" | "field.disc" | "field.compilation"
  | "field.year" | "field.genre" | "field.composer" | "field.bpm" | "field.comment" | "field.lyrics"
  | "info.relativePath" | "info.fileName" | "info.format" | "info.duration" | "info.bitrate" | "info.sampleRate"
  | "info.channels" | "info.mono" | "info.stereo" | "info.bits" | "editor.size" | "info.fullChecksum" | "info.audioChecksum" | "info.lastVerified"
  | `id.${IdField}`;

/** `href`: where the fact can be looked at (an id's page in its database). */
export type Fact = { label: string; text: string; mono?: boolean; long?: boolean; href?: string };

export type TrackFacts = { tags: Fact[]; where: Fact[]; quality: Fact[]; file: Fact[]; ids: Fact[] };

/** The ids shown, in this order, and the page of each in its database (none for jackbird's own). */
const ID_PAGES: [IdField, ((id: string) => string) | null][] = [
  ["mbAlbumId", (id) => `https://musicbrainz.org/release/${id}`],
  ["mbReleaseGroupId", (id) => `https://musicbrainz.org/release-group/${id}`],
  ["mbAlbumArtistId", (id) => `https://musicbrainz.org/artist/${id}`],
  ["mbReleaseTrackId", (id) => `https://musicbrainz.org/track/${id}`],
  ["mbRecordingId", (id) => `https://musicbrainz.org/recording/${id}`],
  ["discogsReleaseId", (id) => `https://www.discogs.com/release/${id}`],
  ["jackbirdTrackId", null]
];

/** The ids a track carries (L5), and only those: a link to each one's page, jackbird's own without. */
export function idFacts(metadata: Partial<Record<IdField, string>>, t: (key: FactKey) => string): Fact[] {
  return ID_PAGES.flatMap(([field, page]) => {
    const id = metadata[field]?.trim();
    if (!id) return [];
    return [{ label: t(`id.${field}`), text: id, mono: true, ...(page ? { href: page(encodeURIComponent(id)) } : {}) }];
  });
}

/** A track's facts, labelled by `t`, numbers and dates in `language`'s way; "-" (`common.none`) where one is unknown. */
export function trackFacts(track: Track, t: (key: FactKey) => string, language: string): TrackFacts {
  const none = t("common.none");
  const { metadata: tags, audio } = track;
  const channels = !audio?.channels ? none : audio.channels === 1 ? t("info.mono") : audio.channels === 2 ? t("info.stereo") : String(audio.channels);
  return {
    tags: [
      { label: t("field.title"), text: tags.title || none },
      { label: t("field.artist"), text: tags.artist || none },
      { label: t("field.album"), text: tags.album || none },
      { label: t("field.albumArtist"), text: tags.albumArtist || none },
      { label: t("field.track"), text: tags.trackNumber || none },
      { label: t("field.disc"), text: tags.discNumber || none },
      { label: t("field.compilation"), text: tags.compilation.trim() === "1" ? t("common.yes") : t("common.no") },
      { label: t("field.year"), text: tags.year || none },
      { label: t("field.genre"), text: tags.genre || none },
      { label: t("field.composer"), text: tags.composer || none },
      { label: t("field.bpm"), text: tags.bpm || none },
      { label: t("field.comment"), text: tags.comment || none, long: true },
      { label: t("field.lyrics"), text: tags.lyrics || none, long: true }
    ],
    where: [
      { label: t("info.relativePath"), text: track.relativePath, mono: true },
      { label: t("info.fileName"), text: track.name }
    ],
    quality: [
      { label: t("info.format"), text: codecLabel(track.relativePath, audio) || none },
      { label: t("info.duration"), text: formatDuration(audio?.durationMs) || none },
      { label: t("info.bitrate"), text: audio?.bitrate ? `${audio.bitrate} kbps${audio.vbr && !audio.bits ? " (VBR)" : ""}` : none },
      { label: t("info.sampleRate"), text: audio?.sampleRate ? `${(audio.sampleRate / 1000).toLocaleString(language, { maximumFractionDigits: 1 })} kHz` : none },
      { label: t("info.channels"), text: channels },
      ...(audio?.bits ? [{ label: t("info.bits"), text: `${audio.bits} bits` }] : [])
    ],
    file: [
      { label: t("editor.size"), text: formatBytes(track.size) },
      { label: t("info.fullChecksum"), text: track.fullChecksum || track.checksum || none, mono: true },
      { label: t("info.audioChecksum"), text: track.audioChecksum || none, mono: true },
      { label: t("info.lastVerified"), text: track.lastVerifiedAt ? new Date(track.lastVerifiedAt).toLocaleString(language) : none }
    ],
    ids: idFacts(tags, t)
  };
}

/** A track's facts in one list, in the selection dialog's order: tags, where, quality, file, ids. */
export function allFacts(facts: TrackFacts): Fact[] {
  return [...facts.tags, ...facts.where, ...facts.quality, ...facts.file, ...facts.ids];
}
