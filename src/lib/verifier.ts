// The background verifier: a while after a root becomes active and its tags
// are loaded, it re-reads the tracks whose checksums are missing or more than
// a day old, one at a time, and records what it finds in the library and in
// `.meta/`.
//
// It never works from what it saw when the run started: at each track it
// takes the root and the track as they are now, waits while a save is under
// way, and drops a result that something else recorded in the meantime (see
// applyVerification). A file changed outside the app has its tags read again,
// so a new checksum is never recorded with old tags. See
// RECORD/2026-11-03.deck-design-system.WIP.md (steps 6 and 7, and the
// verifier fix).

import { $toRaw } from "jq79";
import { applySums, applyVerification, checksumOf, type Sums, type Verification } from "../helpers/snapshot";
import { tracksToVerify } from "../helpers/tracks";
import type { RootWorkspace } from "../types";
import { library } from "./library";
import { flushMeta } from "./meta";
import { updateRoots } from "./roots";

/** How long after a root is ready the verifier starts. */
const START_AFTER_MS = 3000;
/** How long, where the source works out checksums in bulk and some are missing (a folder just read). */
const BULK_AFTER_MS = 300;
/** The pause before each track, so the verifier stays in the background. */
const PAUSE_MS = 300;
/** `.meta/` is written every this many tracks, and at the end. */
const WRITE_EVERY = 10;

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** An open root as the library holds it now. */
function openRoot(rootId: string): RootWorkspace | null {
  return $toRaw(library).roots.find((root) => root.id === rootId) ?? null;
}

/** Reads one track's file: its checksums and, if it changed, its tags, size and date. */
async function inspect(root: RootWorkspace, track: RootWorkspace["tracks"][number]): Promise<Verification> {
  const found = await root.source.inspect(track.relativePath, checksumOf(track));
  const { fullChecksum, audioChecksum, metadata } = found;
  if (!metadata) {
    return { fullChecksum, audioChecksum };
  }
  return { fullChecksum, audioChecksum, file: { metadata, size: found.size, lastModified: found.lastModified ?? track.lastModified } };
}

/** How many times a track is read again because a save started while it was read. */
const RETRIES = 3;

/**
 * The checksums missing from a root, worked out in bulk where its source can (the desktop app:
 * src-tauri/src/scan.rs), all at once and applied a batch at a time: a folder just read by its
 * tags (lib/roots.ts) gets them in the background. A track whose file changed since its tags were
 * read is left to the one-at-a-time pass after, which reads its tags again.
 */
async function sumsInBulk(rootId: string, cancelled: () => boolean): Promise<void> {
  const start = openRoot(rootId);
  const scanSums = start?.source.scanSums;
  const missing = start ? start.tracks.filter((track) => !checksumOf(track)) : [];
  if (!scanSums || missing.length === 0) return;
  const readFrom = new Map(missing.map((track) => [track.id, checksumOf(track)]));
  let pending: Sums[] = [];
  let applied = 0;
  const apply = () => {
    const now = openRoot(rootId);
    // Not while a save is under way: those wait for the pass after.
    if (!now || cancelled() || library.saving || pending.length === 0) return;
    const { root: next, applied: done } = applySums(now, pending, new Date().toISOString());
    pending = [];
    if (done.length === 0) return;
    applied += done.length;
    updateRoots((roots) => roots.map((item) => (item.id === rootId ? next : item)));
  };
  let appliedAt = Date.now();
  await scanSums(
    missing.map((track) => track.relativePath),
    (batch) => {
      for (const sum of batch.sums) {
        pending.push({ trackId: sum.path, readFrom: readFrom.get(sum.path) ?? "", ...sum });
      }
      // A few times a second: each lays the library out again.
      if (batch.done || Date.now() - appliedAt >= 1000) {
        appliedAt = Date.now();
        apply();
      }
    }
  ).catch((error: unknown) => console.error("jackbird: could not work out the checksums", error));
  if (applied > 0 && !cancelled()) await flushMeta(rootId).catch(() => undefined);
}

async function verify(rootId: string, cancelled: () => boolean): Promise<void> {
  await sumsInBulk(rootId, cancelled);
  const start = openRoot(rootId);
  const trackIds = start ? tracksToVerify(start.tracks, Date.now()).map((track) => track.id) : [];
  let verified = 0;
  let index = 0;
  let retries = 0;

  while (index < trackIds.length) {
    const trackId = trackIds[index];
    await pause(PAUSE_MS);
    while (library.saving && !cancelled()) {
      await pause(PAUSE_MS);
    }
    const root = openRoot(rootId);
    if (cancelled() || !root) {
      return;
    }

    const track = root.tracks.find((item) => item.id === trackId);
    let found: Verification | null = null;
    try {
      found = track ? await inspect(root, track) : null;
    } catch {
      // A file that cannot be read now is tried again next time.
    }
    // A save started while the file was read: read it again once it is done.
    if (found && library.saving && retries < RETRIES && !cancelled()) {
      retries += 1;
      continue;
    }
    index += 1;
    retries = 0;

    // Recorded only if nothing else recorded the track since it was read: a
    // save under way, or one already finished (its checksum moved, and
    // applyVerification says so).
    const now = openRoot(rootId);
    const next =
      !track || !found || !now || cancelled() || library.saving
        ? null
        : applyVerification(now, trackId, checksumOf(track), found, new Date().toISOString());
    if (!next) {
      continue;
    }
    updateRoots((roots) => roots.map((item) => (item.id === rootId ? next : item)));
    verified += 1;
    if (verified % WRITE_EVERY === 0) {
      await flushMeta(rootId).catch(() => undefined);
    }
  }

  if (verified > 0 && !cancelled()) {
    await flushMeta(rootId).catch(() => undefined);
  }
}

/**
 * Runs the verifier on the active root whenever one is ready (active, its
 * tags loaded, some tracks), and cancels the run in progress when that
 * changes. Returns the function that stops it.
 */
export function startVerifier(): () => void {
  let readyId: string | null = null;
  let cancel: (() => void) | null = null;

  const stop = library.$effect(() => {
    const roots = library.roots;
    const activeRootId = library.activeRootId;
    const root = $toRaw(roots).find((item) => item.id === activeRootId) ?? null;
    const ready = root && !root.loadingMetadata && root.tracks.length > 0 ? root : null;
    if ((ready?.id ?? null) === readyId) {
      return;
    }

    cancel?.();
    cancel = null;
    readyId = ready?.id ?? null;
    if (ready) {
      let cancelled = false;
      const rootId = ready.id;
      const bulk = !!ready.source.scanSums && ready.tracks.some((track) => !checksumOf(track));
      const timer = setTimeout(() => void verify(rootId, () => cancelled), bulk ? BULK_AFTER_MS : START_AFTER_MS);
      cancel = () => {
        cancelled = true;
        clearTimeout(timer);
      };
    }
  });

  return () => {
    stop();
    cancel?.();
  };
}
