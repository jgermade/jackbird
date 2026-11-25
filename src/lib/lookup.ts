// The rename tab's third way: the tags from a database (RECORD/2026-11-03.deck-design-system.WIP.md,
// 2026-11-25, "the album lookup", L2). The album and artist to look for; the releases MusicBrainz
// finds, best fit first; the one chosen, paired with the dialog's tracks, and per file what would
// change (helpers/lookup.ts); the fields ticked written through the edit dialog's save. Requests go
// one at a time, at MusicBrainz's pace (one a second), straight from the page: it answers any origin.

import { $reactive, $toRaw } from "jq79";
import {
  changedFields,
  lookupPlan,
  lookupTerms,
  musicBrainzRelease,
  musicBrainzReleaseUrl,
  musicBrainzSearch,
  musicBrainzSearchUrl,
  pairTracks,
  scoreRelease,
  withChanges,
  type LookupField,
  type LookupPlan,
  type Release
} from "../helpers/lookup";
import type { Track } from "../types";
import { saveMetadata } from "./editor";
import { t } from "./i18n";
import { Opaque } from "./opaque";
import { dialogTracks } from "./workspace";

/** A candidate as the list shows it: the release's summary and how well it fits, 0 to 100. */
export type Candidate = { release: Release; fit: number };

export const lookup = $reactive({
  album: "",
  artist: "",
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
  fields: [] as LookupField[]
});

/** MusicBrainz asks for one request a second at most. */
const PACE_MS = 1100;
const TIMEOUT_MS = 20000;
let lastAsked = 0;
let queue: Promise<unknown> = Promise.resolve();

/** Asks for JSON, after the one before it and no sooner than the pace allows. */
function ask(url: string): Promise<unknown> {
  const next = queue.then(async () => {
    const wait = lastAsked + PACE_MS - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastAsked = Date.now();
    const response = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!response.ok) throw new Error(t("lookup.failedStatus", { status: String(response.status) }));
    return response.json();
  });
  queue = next.catch(() => undefined);
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
}

/** Looks the album up: MusicBrainz's releases, the best fit first (its own order among equals). */
export async function searchReleases(): Promise<void> {
  if (lookup.busy || (!lookup.album.trim() && !lookup.artist.trim())) return;
  lookup.busy = "search";
  lookup.error = "";
  lookup.chosen = null;
  try {
    const files = tracks();
    const found = musicBrainzSearch(await ask(musicBrainzSearchUrl(lookup.album, lookup.artist)));
    const ranked = found
      .map((release, at) => ({ release, fit: Math.round(scoreRelease(files, release) * 100), at }))
      .sort((left, right) => right.fit - left.fit || left.at - right.at)
      .map(({ release, fit }) => ({ release, fit }));
    lookup.candidates = new Opaque(ranked);
    lookup.searched = true;
  } catch (error) {
    lookup.error = reason(error);
  } finally {
    lookup.busy = "";
  }
}

/** Reads a candidate whole and plans it for the dialog's tracks; every field that changes ticked. */
export async function chooseRelease(id: string): Promise<void> {
  if (lookup.busy) return;
  lookup.busy = "release";
  lookup.error = "";
  try {
    const files = tracks();
    const release = musicBrainzRelease(await ask(musicBrainzReleaseUrl(id)));
    const plans = lookupPlan(pairTracks(files, release), release);
    lookup.chosen = new Opaque({ release, fit: Math.round(scoreRelease(files, release) * 100), plans });
    lookup.fields = changedFields(plans);
  } catch (error) {
    lookup.error = reason(error);
  } finally {
    lookup.busy = "";
  }
}

/** Back to the candidates. */
export function leaveRelease(): void {
  lookup.chosen = null;
  lookup.fields = [];
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
  return (lookup.chosen?.data.plans ?? []).filter((plan) => plan.changes.some((change) => fields.includes(change.field))).length;
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
  const items = chosen.plans.flatMap((plan) => {
    const track = byId.get(plan.trackId);
    return track && plan.changes.some((change) => fields.includes(change.field)) ? [{ track, metadata: withChanges(track.metadata, plan.changes, fields) }] : [];
  });
  return items.length > 0 && saveMetadata(items);
}
