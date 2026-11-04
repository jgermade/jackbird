// The background verifier: a while after a root becomes active and its tags
// are loaded, it re-reads the tracks whose checksums are missing or more than
// a day old, one at a time, and records what it finds in the library and in
// `.meta/`. The former React view's effect as it was. See
// RECORD/2026-11-03.deck-design-system.WIP.md (steps 6 and 7).

import { $toRaw } from "jq79";
import { tracksToVerify } from "../helpers/tracks";
import type { RootWorkspace } from "../types";
import { calculateDualChecksums } from "./id3";
import { library } from "./library";
import { writeMetaSnapshot } from "./meta";
import { updateRoots } from "./roots";

/** How long after a root is ready the verifier starts. */
const START_AFTER_MS = 3000;
/** The pause before each track, so the verifier stays in the background. */
const PAUSE_MS = 300;
/** `.meta/` is written every this many tracks, and at the end. */
const WRITE_EVERY = 10;

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function verify(root: RootWorkspace, cancelled: () => boolean): Promise<void> {
  const candidates = tracksToVerify(root.tracks, Date.now());
  const snapshot = root.metaSnapshot;
  let verified = 0;

  for (const track of candidates) {
    await pause(PAUSE_MS);
    if (cancelled()) {
      return;
    }

    try {
      const { fullChecksum, audioChecksum } = await calculateDualChecksums(await root.vfs.read(track.relativePath));
      const nowIso = new Date().toISOString();

      snapshot.tracks[track.relativePath] = {
        checksum: fullChecksum,
        fullChecksum,
        audioChecksum,
        size: track.size,
        lastModified: track.lastModified,
        lastVerifiedAt: nowIso,
        metadata: track.metadata,
        updatedAt: snapshot.tracks[track.relativePath]?.updatedAt ?? nowIso
      };
      verified += 1;

      updateRoots((roots) =>
        roots.map((item) =>
          item.id !== root.id
            ? item
            : {
                ...item,
                tracks: item.tracks.map((one) =>
                  one.id === track.id ? { ...one, checksum: fullChecksum, fullChecksum, audioChecksum, lastVerifiedAt: nowIso } : one
                ),
                metaSnapshot: snapshot
              }
        )
      );

      if (verified % WRITE_EVERY === 0) {
        await writeMetaSnapshot(root.vfs, snapshot);
      }
    } catch {
      // A file that cannot be read now is tried again next time.
    }
  }

  if (verified > 0 && !cancelled()) {
    await writeMetaSnapshot(root.vfs, snapshot);
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
      const timer = setTimeout(() => void verify(ready, () => cancelled), START_AFTER_MS);
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
