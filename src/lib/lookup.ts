// The rename tab's third way: the tags from a database (RECORD/2026-11-03.deck-design-system.WIP.md,
// 2026-11-25, "the album lookup", L2 and L3). The album and artist to look for; the releases
// MusicBrainz and Discogs find (either or both), best fit first; the one chosen, paired with the
// dialog's tracks, and per file what would change (helpers/lookup.ts); the fields ticked written
// through the edit dialog's save. Each source has its own queue, one request at a time at its pace
// (MusicBrainz one a second; Discogs 25 a minute, 60 with a personal token), straight from the page:
// both answer any origin. Discogs' token, optional, is kept in this browser and sent to it alone.

import { $reactive, $toRaw } from "jq79";
import {
  changedFields,
  coverArtUrl,
  coverWanted,
  discogsHeaders,
  discogsRelease,
  discogsReleaseUrl,
  discogsSearch,
  discogsSearchUrl,
  lookupPlan,
  lookupTerms,
  mergeCandidates,
  musicBrainzRelease,
  musicBrainzReleaseUrl,
  musicBrainzSearch,
  musicBrainzSearchUrl,
  paceOf,
  pairTracks,
  scaledSize,
  scoreRelease,
  withChanges,
  type LookupField,
  type LookupPlan,
  type LookupSource,
  type Release
} from "../helpers/lookup";
import type { Track } from "../types";
import { saveMetadata } from "./editor";
import { t } from "./i18n";
import { Opaque } from "./opaque";
import { STORAGE_KEYS, readStored, removeStored, writeStored } from "./storage";
import { dialogTracks } from "./workspace";

/** A candidate as the list shows it: the release's summary and how well it fits, 0 to 100. */
export type Candidate = { release: Release; fit: number };

export const SOURCES: readonly LookupSource[] = ["musicbrainz", "discogs"];
const storedSources = (): LookupSource[] => {
  const kept = (readStored(STORAGE_KEYS.lookupSources) ?? "").split(",").filter((one): one is LookupSource => SOURCES.includes(one as LookupSource));
  return kept.length > 0 ? kept : [...SOURCES];
};

export const lookup = $reactive({
  album: "",
  artist: "",
  /** Where to look: MusicBrainz, Discogs, or both (the default), as last chosen. */
  sources: storedSources(),
  /** Discogs' personal token, optional (Preferences, Library). */
  discogsToken: readStored(STORAGE_KEYS.discogsToken) ?? "",
  /** What is being asked: nothing, a search, or the release chosen. */
  busy: "" as "" | "search" | "release",
  error: "",
  /** Searched at least once (an empty list then says nothing was found). */
  searched: false,
  /** Boxed (see Opaque): the store never copies them field by field. */
  candidates: new Opaque<Candidate[]>([]),
  /** The release chosen, read whole, and its plan for the dialog's tracks. */
  chosen: null as Opaque<{ release: Release; fit: number; plans: LookupPlan[] }> | null,
  /** The fields to write, of those that change. */
  fields: [] as LookupField[],
  /**
   * The release's cover (L4): the Cover Art Archive's front picture of a MusicBrainz release, as a
   * data URL once fetched ("none": it has none; "discogs": Discogs' pictures cannot be read from a
   * page, as their server does not allow it). Written with the fields when ticked; ticked at first
   * only where none of the files has a cover.
   */
  cover: { state: "" as "" | "loading" | "ready" | "none" | "discogs", dataUrl: "", on: false }
});

/** Looks in a source or not; one at least stays. Kept for the next time. */
export function toggleSource(source: LookupSource, on: boolean): void {
  const rest = lookup.sources.filter((one) => one !== source);
  const next = on ? SOURCES.filter((one) => one === source || rest.includes(one)) : rest;
  if (next.length === 0) return;
  lookup.sources = next;
  writeStored(STORAGE_KEYS.lookupSources, next.join(","));
}

/** Discogs' token: kept in this browser, or forgotten when emptied. */
export function setDiscogsToken(token: string): void {
  lookup.discogsToken = token.trim();
  if (lookup.discogsToken) writeStored(STORAGE_KEYS.discogsToken, lookup.discogsToken);
  else removeStored(STORAGE_KEYS.discogsToken);
}

export const sourceName = (source: LookupSource): string => (source === "musicbrainz" ? "MusicBrainz" : "Discogs");

const TIMEOUT_MS = 20000;
const RETRIES = 2;
const queues: Record<LookupSource, { last: number; queue: Promise<unknown> }> = {
  musicbrainz: { last: 0, queue: Promise.resolve() },
  discogs: { last: 0, queue: Promise.resolve() }
};

/** Asks a source for JSON, after its request before and no sooner than its pace allows. */
function ask(source: LookupSource, url: string): Promise<unknown> {
  const line = queues[source];
  const token = source === "discogs" ? $toRaw(lookup).discogsToken : "";
  const next = line.queue.then(async () => {
    const wait = line.last + paceOf(source, token) - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    line.last = Date.now();
    const headers = { Accept: "application/json", ...(source === "discogs" ? discogsHeaders(token) : {}) };
    // Busy (503, MusicBrainz's way of saying "slower") or too many (429): asked again, twice at most,
    // a little later each time.
    for (let attempt = 0; ; attempt += 1) {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
      line.last = Date.now();
      if (response.ok) return response.json();
      if ((response.status === 503 || response.status === 429) && attempt < RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, paceOf(source, token) * (attempt + 2)));
        continue;
      }
      throw new Error(t("lookup.failedStatus", { source: sourceName(source), status: String(response.status) }));
    }
  });
  line.queue = next.catch(() => undefined);
  return next;
}

const tracks = (): Track[] => dialogTracks.value.data;
const reason = (error: unknown): string => (error instanceof Error && error.message ? error.message : t("lookup.failed"));

let lookedFor = "";

/** Starts afresh when the dialog's tracks are others than the last ones looked up for. */
export function syncLookup(files: readonly Pick<Track, "id">[]): void {
  const key = files.map((file) => file.id).join("\n");
  if (key !== lookedFor) resetLookup();
}

/** Starts afresh for the dialog's tracks: the album and artist they share, nothing found yet. */
export function resetLookup(): void {
  lookedFor = tracks().map((track) => track.id).join("\n");
  const terms = lookupTerms(tracks());
  lookup.album = terms.album;
  lookup.artist = terms.artist;
  lookup.busy = "";
  lookup.error = "";
  lookup.searched = false;
  lookup.candidates = new Opaque([]);
  lookup.chosen = null;
  lookup.fields = [];
  lookup.cover = { state: "", dataUrl: "", on: false };
}

/** One source's releases for the terms, with their fit for the files. */
async function searchIn(source: LookupSource, album: string, artist: string, files: Track[]): Promise<Candidate[]> {
  const found = source === "musicbrainz" ? musicBrainzSearch(await ask(source, musicBrainzSearchUrl(album, artist))) : discogsSearch(await ask(source, discogsSearchUrl(album, artist)));
  return found.map((release) => ({ release, fit: Math.round(scoreRelease(files, release) * 100) }));
}

/**
 * Looks the album up in the sources chosen, side by side: their releases in one list, the best fit
 * first. A source that fails says so; the other's releases are still shown.
 */
export async function searchReleases(): Promise<void> {
  if (lookup.busy || (!lookup.album.trim() && !lookup.artist.trim())) return;
  lookup.busy = "search";
  lookup.error = "";
  lookup.chosen = null;
  try {
    const files = tracks();
    const sources = [...$toRaw(lookup).sources];
    const answers = await Promise.allSettled(sources.map((source) => searchIn(source, lookup.album, lookup.artist, files)));
    const found = answers.flatMap((answer) => (answer.status === "fulfilled" ? [answer.value] : []));
    const failed = answers.flatMap((answer) => (answer.status === "rejected" ? [reason(answer.reason)] : []));
    lookup.candidates = new Opaque(mergeCandidates(found));
    lookup.error = failed.join(" ");
    lookup.searched = found.length > 0;
  } finally {
    lookup.busy = "";
  }
}

/** Reads a candidate whole and plans it for the dialog's tracks; every field that changes ticked. */
export async function chooseRelease(source: LookupSource, id: string): Promise<void> {
  if (lookup.busy) return;
  lookup.busy = "release";
  lookup.error = "";
  try {
    const files = tracks();
    const release = source === "musicbrainz" ? musicBrainzRelease(await ask(source, musicBrainzReleaseUrl(id))) : discogsRelease(await ask(source, discogsReleaseUrl(id)));
    const plans = lookupPlan(pairTracks(files, release), release);
    lookup.chosen = new Opaque({ release, fit: Math.round(scoreRelease(files, release) * 100), plans });
    lookup.fields = changedFields(plans);
    lookup.cover = { state: source === "musicbrainz" ? "loading" : "discogs", dataUrl: "", on: false };
    if (source === "musicbrainz") void fetchCover(release.id, coverWanted(files));
  } catch (error) {
    lookup.error = reason(error);
  } finally {
    lookup.busy = "";
  }
}

/** The largest side a cover is kept at, as the edit dialog's picture (views/selection-dialog.html). */
const COVER_MAX = 1000;

/** A picture scaled down to COVER_MAX at most, as a JPEG data URL. */
async function scaledDataUrl(blob: Blob): Promise<string> {
  const bitmap = await createImageBitmap(blob);
  const size = scaledSize(bitmap.width, bitmap.height, COVER_MAX);
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  canvas.getContext("2d")?.drawImage(bitmap, 0, 0, size.width, size.height);
  bitmap.close();
  const scaled = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.9));
  return blobToDataUrl(scaled ?? blob);
}

const blobToDataUrl = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });

/** The chosen MusicBrainz release's front picture, if it has one; dropped if another is chosen meanwhile. */
async function fetchCover(releaseId: string, wanted: boolean): Promise<void> {
  const still = () => $toRaw(lookup).chosen?.data.release.id === releaseId;
  try {
    const response = await fetch(coverArtUrl(releaseId), { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!still()) return;
    if (!response.ok) {
      lookup.cover = { state: "none", dataUrl: "", on: false };
      return;
    }
    const dataUrl = await scaledDataUrl(await response.blob());
    if (still()) lookup.cover = { state: "ready", dataUrl, on: wanted };
  } catch {
    if (still()) lookup.cover = { state: "none", dataUrl: "", on: false };
  }
}

/** Ticks or unticks the cover. */
export function toggleCover(on: boolean): void {
  if (lookup.cover.state === "ready") lookup.cover = { ...lookup.cover, on };
}

/** Back to the candidates. */
export function leaveRelease(): void {
  lookup.chosen = null;
  lookup.fields = [];
  lookup.cover = { state: "", dataUrl: "", on: false };
}

/** Ticks or unticks a field to write. */
export function toggleField(field: LookupField, on: boolean): void {
  const rest = lookup.fields.filter((one) => one !== field);
  lookup.fields = on ? [...rest, field] : rest;
}

/** The files the plan would change with the fields ticked. */
export function lookupCount(): number {
  // Read through the store (not $toRaw): the key's count follows the boxes.
  const fields = [...lookup.fields];
  const cover = lookup.cover.on && lookup.cover.state === "ready";
  return (lookup.chosen?.data.plans ?? []).filter((plan) => (cover && plan.track) || plan.changes.some((change) => fields.includes(change.field))).length;
}

/**
 * Writes the fields ticked to the files they change, through the edit dialog's save. Resolves to
 * whether it all went.
 */
export async function applyLookup(): Promise<boolean> {
  const chosen = $toRaw(lookup).chosen?.data;
  if (!chosen) return false;
  const fields = [...$toRaw(lookup).fields];
  const byId = new Map(tracks().map((track) => [track.id, track]));
  const cover = $toRaw(lookup).cover;
  const coverUrl = cover.on && cover.state === "ready" ? cover.dataUrl : null;
  const items = chosen.plans.flatMap((plan) => {
    const track = byId.get(plan.trackId);
    if (!track || !(plan.changes.some((change) => fields.includes(change.field)) || (coverUrl && plan.track))) return [];
    const metadata = withChanges(track.metadata, plan.changes, fields);
    // The cover to every file paired with a track of the release.
    return [{ track, metadata: coverUrl && plan.track ? { ...metadata, coverDataUrl: coverUrl } : metadata }];
  });
  return items.length > 0 && saveMetadata(items);
}
