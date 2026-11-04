// Actions on the open folders ("roots"): open, restore and resync one
// (hydrateRoot), choose one, close one, and show the playing queue in it.
// They write the `library` store; the views read it.

import { FSAAdapter, isFSAAvailable, walk, type VFSAdapter } from "@cloudauthn/vfs-sync";
import { $toRaw } from "jq79";
import { emptyMetadata } from "../helpers/metadata";
import type { GroupingMode, Mp3Track, RootWorkspace, TrackMetadata } from "../types";
import { t, tn } from "./i18n";
import { calculateDualChecksums, readTrackMetadataFromBytes } from "./id3";
import { library } from "./library";
import { readMetaSnapshot, writeMetaSnapshot } from "./meta";
import { playback } from "./playback";

/** Replaces the roots with `update(current)`, as a setState updater would. */
export function updateRoots(update: (roots: RootWorkspace[]) => RootWorkspace[]): void {
  library.roots = update($toRaw(library).roots);
}

/**
 * Opens a folder in the library, or refreshes one already open: renders what
 * `.meta/` remembers at once, then walks the folder in the background and
 * reads the tags of new and changed files.
 */
export async function hydrateRoot(
  vfs: VFSAdapter,
  options: {
    rootHandle: FileSystemDirectoryHandle;
    rootId?: string;
    rootLabel?: string;
    groupingMode?: GroupingMode;
    setActive?: boolean;
  }
): Promise<void> {
  const rootId = options.rootId ?? `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const rootLabel = options.rootLabel ?? (vfs.name || t("roots.fallbackName", { number: $toRaw(library).roots.length + 1 }));
  const groupingMode = options.groupingMode ?? "wizard";

  // ─── Phase 1: Snapshot → instant render ──────────────────────────────────
  const snapshot = await readMetaSnapshot(vfs);

  const snapshotEntries = Object.entries(snapshot.tracks);
  const initialTracks: Mp3Track[] = snapshotEntries.map(([relativePath, stored]) => ({
    id: relativePath,
    name: relativePath.split("/").at(-1) ?? relativePath,
    relativePath,
    size: stored.size ?? 0,
    lastModified: stored.lastModified,
    checksum: stored.fullChecksum || stored.checksum,
    fullChecksum: stored.fullChecksum || stored.checksum,
    audioChecksum: stored.audioChecksum,
    lastVerifiedAt: stored.lastVerifiedAt,
    metadata: stored.metadata
  }));

  updateRoots((currentRoots) => {
    const existingIndex = currentRoots.findIndex((root) => root.id === rootId);
    const nextRoot: RootWorkspace = {
      id: rootId,
      label: rootLabel,
      vfs,
      rootHandle: options.rootHandle,
      tracks: initialTracks,
      selectedTrackId: null,
      selectedTrackIds: [],
      selectionAnchorTrackId: null,
      loadingMetadata: true, // walk is pending
      loadedCount: initialTracks.length,
      groupingMode,
      metaSnapshot: snapshot,
      expandedAlbums: [],
      expandedDiscs: [],
      activeRowKey: null
    };

    if (existingIndex === -1) {
      return [...currentRoots, nextRoot];
    }

    const copy = [...currentRoots];
    copy[existingIndex] = {
      ...nextRoot,
      expandedAlbums: currentRoots[existingIndex].expandedAlbums,
      expandedDiscs: currentRoots[existingIndex].expandedDiscs,
      activeRowKey: currentRoots[existingIndex].activeRowKey
    };
    return copy;
  });

  if (options.setActive !== false) {
    library.activeRootId = rootId;
  }

  // ─── Phase 2: Filesystem walk (background) ────────────────────────────────
  void (async () => {
    try {
      const mp3Files = (await walk(vfs))
        .filter((entry) => entry.path.toLowerCase().endsWith(".mp3"))
        .map((entry) => ({
          name: entry.path.split("/").at(-1) ?? entry.path,
          relativePath: entry.path,
          size: entry.stat.size,
          lastModified: entry.stat.mtime
        }));

      const snapshotPaths = new Set(Object.keys(snapshot.tracks));
      const fsPaths = new Set(mp3Files.map((f) => f.relativePath));

      // Tracks removed from disk
      const removedPaths = [...snapshotPaths].filter((p) => !fsPaths.has(p));

      // New files not in snapshot
      const newFiles = mp3Files.filter((f) => !snapshotPaths.has(f.relativePath));

      // Files that exist in both but have changed size/lastModified
      const modifiedFiles = mp3Files.filter((f) => {
        const stored = snapshot.tracks[f.relativePath];
        return stored && (stored.size !== f.size || stored.lastModified !== f.lastModified);
      });

      const staleOrNewFiles = [...newFiles, ...modifiedFiles];
      const isFullyCached = staleOrNewFiles.length === 0 && removedPaths.length === 0;

      // Drop tracks that are gone from disk
      updateRoots((currentRoots) =>
        currentRoots.map((root) => {
          if (root.id !== rootId) {
            return root;
          }

          const tracks = root.tracks.filter((t) => !removedPaths.includes(t.relativePath));

          // Add genuinely new files (not in snapshot at all) as empty placeholder tracks
          for (const file of newFiles) {
            tracks.push({
              id: file.relativePath,
              name: file.name,
              relativePath: file.relativePath,
              size: file.size,
              lastModified: file.lastModified,
              checksum: "",
              fullChecksum: undefined,
              audioChecksum: undefined,
              lastVerifiedAt: undefined,
              metadata: emptyMetadata()
            });
          }

          return {
            ...root,
            tracks,
            loadingMetadata: !isFullyCached,
            loadedCount: tracks.length - staleOrNewFiles.length
          };
        })
      );

      if (removedPaths.length > 0) {
        for (const p of removedPaths) {
          delete snapshot.tracks[p];
        }
      }

      if (isFullyCached) {
        updateRoots((currentRoots) =>
          currentRoots.map((root) =>
            root.id === rootId ? { ...root, loadingMetadata: false } : root
          )
        );
        return;
      }

      // Process stale/new files concurrently
      type TrackUpdate = {
        trackId: string;
        metadata: TrackMetadata;
        fullChecksum: string;
        audioChecksum: string;
        size: number;
        lastModified?: number;
        lastVerifiedAt: string;
      };

      const pendingUpdates: TrackUpdate[] = [];
      // Counted against the walk, as the root's own count above: what is
      // already known, then one per file read, ending at the total (when the
      // last batch is flushed).
      const totalAfterWalk = mp3Files.length;
      let loadedCount = totalAfterWalk - staleOrNewFiles.length;
      let snapshotDirty = removedPaths.length > 0;

      function flush(): void {
        const updates = [...pendingUpdates];
        pendingUpdates.length = 0;

        updateRoots((currentRoots) =>
          currentRoots.map((root) => {
            if (root.id !== rootId) {
              return root;
            }

            const nextTracksById = new Map(root.tracks.map((item) => [item.id, item]));

            for (const update of updates) {
              const currentTrack = nextTracksById.get(update.trackId);
              if (!currentTrack) {
                continue;
              }

              nextTracksById.set(update.trackId, {
                ...currentTrack,
                checksum: update.fullChecksum,
                fullChecksum: update.fullChecksum,
                audioChecksum: update.audioChecksum,
                size: update.size,
                lastModified: update.lastModified,
                lastVerifiedAt: update.lastVerifiedAt,
                metadata: update.metadata
              });
            }

            return {
              ...root,
              tracks: root.tracks.map((item) => nextTracksById.get(item.id) ?? item),
              loadedCount,
              loadingMetadata: loadedCount < totalAfterWalk,
              metaSnapshot: snapshot
            };
          })
        );
      }

      const READ_CONCURRENCY = 6;
      let cursor = 0;
      let failedCount = 0;

      // Reads one file's checksums and tags into the snapshot and the next flush.
      async function readOne(file: (typeof staleOrNewFiles)[number]): Promise<void> {
        const sourceBytes = await vfs.read(file.relativePath);
        const { fullChecksum, audioChecksum } = await calculateDualChecksums(sourceBytes);
        const stored = snapshot.tracks[file.relativePath];
        const metadata =
          stored && (stored.fullChecksum || stored.checksum) === fullChecksum
            ? stored.metadata
            : await readTrackMetadataFromBytes(sourceBytes, file.name);

        const nowIso = new Date().toISOString();
        snapshot.tracks[file.relativePath] = {
          checksum: fullChecksum,
          fullChecksum,
          audioChecksum,
          size: file.size,
          lastModified: file.lastModified,
          lastVerifiedAt: nowIso,
          metadata,
          updatedAt: nowIso
        };
        snapshotDirty = true;

        pendingUpdates.push({
          trackId: file.relativePath,
          metadata,
          fullChecksum,
          audioChecksum,
          size: file.size,
          lastModified: file.lastModified,
          lastVerifiedAt: nowIso
        });
      }

      async function worker(): Promise<void> {
        while (true) {
          const itemIndex = cursor;
          cursor += 1;
          if (itemIndex >= staleOrNewFiles.length) {
            return;
          }

          const file = staleOrNewFiles[itemIndex];
          try {
            await readOne(file);
          } catch (error) {
            // A file that cannot be read keeps its place, untagged, and the
            // others go on loading; the library says how many failed.
            failedCount += 1;
            console.error(`jackbird: could not read ${file.relativePath}`, error);
          }
          loadedCount += 1;

          if (loadedCount % 10 === 0 || loadedCount === totalAfterWalk) {
            flush();
          }
        }
      }

      await Promise.all(
        Array.from({ length: Math.min(READ_CONCURRENCY, staleOrNewFiles.length) }, () => worker())
      );

      if (snapshotDirty) {
        await writeMetaSnapshot(vfs, snapshot);
      }

      updateRoots((currentRoots) =>
        currentRoots.map((root) =>
          root.id === rootId
            ? {
                ...root,
                loadingMetadata: false,
                loadedCount: totalAfterWalk,
                metaSnapshot: snapshot
              }
            : root
        )
      );

      if (failedCount > 0) {
        library.errorMessage = tn("message.readFailed", failedCount, { name: rootLabel });
      }
    } catch (error) {
      // The walk or the snapshot's write failed: what the snapshot had is still usable.
      console.error(`jackbird: could not finish loading ${rootLabel}`, error);
      updateRoots((currentRoots) =>
        currentRoots.map((root) =>
          root.id === rootId ? { ...root, loadingMetadata: false } : root
        )
      );
    }
  })();
}

/** Asks for a folder and opens it. */
export async function openFolder(): Promise<void> {
  library.loading = true;
  library.errorMessage = null;
  library.infoMessage = null;

  try {
    if (!isFSAAvailable()) {
      throw new Error(t("message.noFsa"));
    }
    const vfs = await FSAAdapter.pick();
    await hydrateRoot(vfs, { rootHandle: vfs.root });
  } catch (error) {
    library.errorMessage = error instanceof Error ? error.message : t("message.scanFailed");
  } finally {
    library.loading = false;
  }
}

/** Makes a root the active one, and re-reads it if its files changed on disk. */
export function selectRoot(rootId: string): void {
  library.activeRootId = rootId;
  library.infoMessage = null;
  library.errorMessage = null;
  void resyncRootIfNeeded(rootId);
}

async function resyncRootIfNeeded(rootId: string): Promise<void> {
  const root = $toRaw(library).roots.find((item) => item.id === rootId);
  if (!root || root.loadingMetadata) {
    return;
  }

  const currentFiles = (await walk(root.vfs)).filter((entry) => entry.path.toLowerCase().endsWith(".mp3"));
  const currentPaths = new Set(currentFiles.map((file) => file.path));
  const knownPaths = new Set(root.tracks.map((track) => track.relativePath));
  if (currentFiles.length === root.tracks.length && [...currentPaths].every((path) => knownPaths.has(path))) {
    return;
  }

  library.infoMessage = t("message.resyncing", { name: root.label });
  await hydrateRoot(root.vfs, {
    rootHandle: root.rootHandle,
    rootId: root.id,
    rootLabel: root.label,
    groupingMode: root.groupingMode,
    setActive: false
  });
}

/** Closes a root; playback from it stops, and its neighbour becomes active. */
export function closeRoot(rootId: string): void {
  const { roots, activeRootId } = $toRaw(library);
  const index = roots.findIndex((root) => root.id === rootId);
  if (index === -1) {
    return;
  }

  if ($toRaw(playback).queue?.rootId === rootId) {
    playback.queue = null;
    playback.index = 0;
  }

  const nextRoots = roots.filter((root) => root.id !== rootId);
  library.roots = nextRoots;
  if (activeRootId === rootId) {
    library.activeRootId = (nextRoots[index] ?? nextRoots[index - 1] ?? null)?.id ?? null;
  }
}

/** Opens the root the queue plays from, with the queue's tracks selected. */
export function showQueueInLibrary(): void {
  const queue = $toRaw(playback).queue;
  if (!queue) {
    return;
  }

  library.activeRootId = queue.rootId;
  updateRoots((roots) =>
    roots.map((root) =>
      root.id === queue.rootId
        ? {
            ...root,
            selectedTrackId: null,
            selectedTrackIds: queue.trackIds,
            selectionAnchorTrackId: null,
            activeRowKey: null
          }
        : root
    )
  );
}
