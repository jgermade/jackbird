// Actions on the open folders ("roots"): open, restore and resync one
// (hydrateRoot), choose one, close one, and show the playing queue in it.
// They write the `library` store; the views read it.

import { $toRaw } from "jq79";
import type { SampleList } from "../helpers/samples";
import { emptyMetadata } from "../helpers/metadata";
import { isAudioFile } from "../helpers/formats";
import { isPlaylistFile } from "../helpers/playlists";
import { applyScanResults, checksumOf, omitRecords, type ScanResult } from "../helpers/snapshot";
import { collectFolderPaths } from "../helpers/tracks";
import type { GroupingMode, LibraryView, RootSource, RootWorkspace, Track } from "../types";
import { t, tn } from "./i18n";
import { library } from "./library";
import { flushMeta, readMetaSnapshot } from "./meta";
import { dropFromQueue } from "./player";
import { loadPlaylists } from "./playlists";
import { forgetRecent, rememberClosed } from "./recent";
import { pickSource } from "./sources";
import type { ServiceClient } from "./sources/service";

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
  source: RootSource,
  options: {
    rootId?: string;
    rootLabel?: string;
    groupingMode?: GroupingMode;
    setActive?: boolean;
    /** Where a reopened root was: its open folders and its current row. */
    expandedAlbums?: string[];
    activeRowKey?: string | null;
    view?: LibraryView;
  }
): Promise<void> {
  // Open again: no longer offered among the folders closed lately.
  forgetRecent(source.saved);
  const vfs = source.vfs;
  const rootId = options.rootId ?? `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const rootLabel = options.rootLabel ?? (vfs.name || t("roots.fallbackName", { number: $toRaw(library).roots.length + 1 }));
  const groupingMode = options.groupingMode ?? "wizard";

  // ─── Phase 1: Snapshot → instant render ──────────────────────────────────
  const snapshot = await readMetaSnapshot(vfs);

  const snapshotEntries = Object.entries(snapshot.tracks);
  const initialTracks: Track[] = snapshotEntries.map(([relativePath, stored]) => ({
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
      source,
      tracks: initialTracks,
      selectedTrackId: null,
      selectedTrackIds: [],
      selectionAnchorTrackId: null,
      loadingMetadata: true, // walk is pending
      loadedCount: initialTracks.length,
      groupingMode,
      metaSnapshot: snapshot,
      expandedAlbums: options.expandedAlbums ?? [],
      expandedDiscs: [],
      activeRowKey: options.activeRowKey ?? null,
      view: options.view ?? "files",
      playlists: []
    };

    if (existingIndex === -1) {
      return [...currentRoots, nextRoot];
    }

    const copy = [...currentRoots];
    copy[existingIndex] = {
      ...nextRoot,
      expandedAlbums: currentRoots[existingIndex].expandedAlbums,
      expandedDiscs: currentRoots[existingIndex].expandedDiscs,
      activeRowKey: currentRoots[existingIndex].activeRowKey,
      view: currentRoots[existingIndex].view,
      playlists: currentRoots[existingIndex].playlists
    };
    return copy;
  });

  if (options.setActive !== false) {
    library.activeRootId = rootId;
  }

  // ─── Phase 2: Filesystem walk (background) ────────────────────────────────
  void (async () => {
    try {
      const walked = await source.walk();
      // The playlists are read beside the tracks, and do not hold them up.
      void loadPlaylists(rootId, walked.map((entry) => entry.path)).catch((error: unknown) =>
        console.error(`jackbird: could not read the playlists of ${rootLabel}`, error)
      );
      const audioFiles = walked
        .filter((entry) => isAudioFile(entry.path))
        .map((entry) => ({
          name: entry.path.split("/").at(-1) ?? entry.path,
          relativePath: entry.path,
          size: entry.stat.size,
          lastModified: entry.stat.mtime
        }));

      const snapshotPaths = new Set(Object.keys(snapshot.tracks));
      const fsPaths = new Set(audioFiles.map((f) => f.relativePath));

      // Tracks removed from disk
      const removedPaths = [...snapshotPaths].filter((p) => !fsPaths.has(p));

      // New files not in snapshot
      const newFiles = audioFiles.filter((f) => !snapshotPaths.has(f.relativePath));

      // Files that exist in both but have changed size/lastModified
      const modifiedFiles = audioFiles.filter((f) => {
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
            metaSnapshot: omitRecords(root.metaSnapshot, removedPaths),
            loadingMetadata: !isFullyCached,
            loadedCount: tracks.length - staleOrNewFiles.length
          };
        })
      );

      if (isFullyCached) {
        updateRoots((currentRoots) =>
          currentRoots.map((root) =>
            root.id === rootId ? { ...root, loadingMetadata: false } : root
          )
        );
        return;
      }

      // Process stale/new files concurrently. The snapshot read at the start
      // only says what is already known; each result is applied to the root
      // as it is when the batch is flushed, unless a save recorded its track
      // since its file was read (applyScanResults), and `.meta/` is written
      // through the queue every writer uses (flushMeta).
      const pendingUpdates: ScanResult[] = [];
      // Counted against the walk, as the root's own count above: what is
      // already known, then one per file read, ending at the total (when the
      // last batch is flushed).
      const totalAfterWalk = audioFiles.length;
      let loadedCount = totalAfterWalk - staleOrNewFiles.length;
      let snapshotDirty = removedPaths.length > 0;

      function flush(): void {
        const updates = [...pendingUpdates];
        pendingUpdates.length = 0;

        updateRoots((currentRoots) =>
          currentRoots.map((root) =>
            root.id === rootId
              ? { ...applyScanResults(root, updates), loadedCount, loadingMetadata: loadedCount < totalAfterWalk }
              : root
          )
        );
      }

      const READ_CONCURRENCY = 6;
      const FLUSH_EVERY_MS = 400;
      let flushedAt = Date.now();
      let cursor = 0;
      let failedCount = 0;

      // The checksum a track has in the library now, or "" when it is gone.
      function checksumNow(trackId: string): string {
        const track = $toRaw(library).roots.find((root) => root.id === rootId)?.tracks.find((item) => item.id === trackId);
        return track ? checksumOf(track) : "";
      }

      // Reads one file's checksums and tags into the next flush.
      async function readOne(file: (typeof staleOrNewFiles)[number]): Promise<void> {
        const readFrom = checksumNow(file.relativePath);
        const stored = snapshot.tracks[file.relativePath];
        const known = stored ? stored.fullChecksum || stored.checksum : undefined;
        const found = await source.inspect(file.relativePath, known);
        const { fullChecksum, audioChecksum } = found;
        const metadata = found.metadata ?? stored?.metadata ?? emptyMetadata();

        const nowIso = new Date().toISOString();
        pendingUpdates.push({
          trackId: file.relativePath,
          readFrom,
          record: {
            checksum: fullChecksum,
            fullChecksum,
            audioChecksum,
            // The file as it was read, which may be newer than the walk saw it (a sample still on its way).
            size: found.size,
            lastModified: found.lastModified ?? file.lastModified,
            lastVerifiedAt: nowIso,
            metadata,
            updatedAt: nowIso
          }
        });
        snapshotDirty = true;
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

          // What was read goes to the library a few times a second, not every few files: each
          // flush lays the library out again (the tree, the albums), and on a large one that was
          // most of the loading's time, the more so in WebKit (the macOS app).
          if (loadedCount === totalAfterWalk || Date.now() - flushedAt >= FLUSH_EVERY_MS) {
            flushedAt = Date.now();
            flush();
          }
        }
      }

      await Promise.all(
        Array.from({ length: Math.min(READ_CONCURRENCY, staleOrNewFiles.length) }, () => worker())
      );

      if (snapshotDirty) {
        await flushMeta(rootId);
      }

      updateRoots((currentRoots) =>
        currentRoots.map((root) =>
          root.id === rootId ? { ...root, loadingMetadata: false, loadedCount: totalAfterWalk } : root
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

/** Asks for a folder and opens it: one of this device, or of `server`'s machine (E6b-D11). */
export async function openFolder(server?: ServiceClient): Promise<void> {
  library.loading = true;
  library.errorMessage = null;
  library.infoMessage = null;

  try {
    const source = await pickSource(server);
    if (source) {
      await hydrateRoot(source, {});
    }
  } catch (error) {
    // The dialog closed with no folder chosen (the browser's picker rejects with AbortError): nothing to say.
    if (error instanceof DOMException && error.name === "AbortError") return;
    library.errorMessage = error instanceof Error ? error.message : t("message.scanFailed");
  } finally {
    library.loading = false;
  }
}

/** Opens the demo's sample music (lib/sources/samples.ts) as a folder. */
export async function openSamples(list: SampleList): Promise<void> {
  library.loading = true;
  library.errorMessage = null;
  library.infoMessage = null;
  try {
    const { openSampleSource } = await import("./sources/samples");
    // One id wherever it is opened: the landing page's two frames name its tracks alike (lib/mirror.ts).
    await hydrateRoot(await openSampleSource(list), { rootId: "samples" });
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

/** Reads a root again if its files changed (songs added to the library, say). */
export function refreshRoot(rootId: string): Promise<void> {
  return resyncRootIfNeeded(rootId);
}

/**
 * Scans a root again, whatever changed: walks its folder and reads the tags of new and changed
 * files (the library's rescan key). Nothing while it is still being read.
 */
export async function rescanRoot(rootId: string): Promise<void> {
  const root = $toRaw(library).roots.find((item) => item.id === rootId);
  if (!root || root.loadingMetadata) return;
  library.errorMessage = null;
  library.infoMessage = null;
  await hydrateRoot(root.source, {
    rootId: root.id,
    rootLabel: root.label,
    groupingMode: root.groupingMode,
    setActive: false
  });
}

async function resyncRootIfNeeded(rootId: string): Promise<void> {
  const root = $toRaw(library).roots.find((item) => item.id === rootId);
  if (!root || root.loadingMetadata) {
    return;
  }

  const walked = await root.source.walk();
  // Playlists made or deleted elsewhere since: read them again.
  const playlistPaths = walked.map((entry) => entry.path).filter(isPlaylistFile);
  const knownPlaylists = new Set((root.playlists ?? []).map((playlist) => playlist.path));
  if (playlistPaths.length !== knownPlaylists.size || playlistPaths.some((path) => !knownPlaylists.has(path))) {
    void loadPlaylists(root.id, walked.map((entry) => entry.path));
  }
  const currentFiles = walked.filter((entry) => isAudioFile(entry.path));
  const currentPaths = new Set(currentFiles.map((file) => file.path));
  const knownPaths = new Set(root.tracks.map((track) => track.relativePath));
  if (currentFiles.length === root.tracks.length && [...currentPaths].every((path) => knownPaths.has(path))) {
    return;
  }

  library.infoMessage = t("message.resyncing", { name: root.label });
  await hydrateRoot(root.source, {
    rootId: root.id,
    rootLabel: root.label,
    groupingMode: root.groupingMode,
    setActive: false
  });
}

/**
 * Closes a root, and its neighbour becomes active. Its tracks leave the
 * queue; if the one playing was one of them, the next one left plays.
 */
export function closeRoot(rootId: string): void {
  const { roots, activeRootId } = $toRaw(library);
  const index = roots.findIndex((root) => root.id === rootId);
  if (index === -1) {
    return;
  }

  dropFromQueue((item) => item.rootId === rootId);
  roots[index].source.close();
  // Offered again in "Add to the library…"'s Folder tab.
  rememberClosed({ label: roots[index].label, saved: roots[index].source.saved });

  const nextRoots = roots.filter((root) => root.id !== rootId);
  library.roots = nextRoots;
  if (activeRootId === rootId) {
    library.activeRootId = (nextRoots[index] ?? nextRoots[index - 1] ?? null)?.id ?? null;
  }
}

/**
 * Opens a track's root at that track: its folders open in the tree and it
 * becomes the current row, so the album sheet shows its folder. The
 * selection stays as it is.
 */
export function showInLibrary(rootId: string, trackId: string): void {
  library.activeRootId = rootId;
  updateRoots((roots) =>
    roots.map((root) => {
      const track = root.id === rootId ? root.tracks.find((item) => item.id === trackId) : undefined;
      if (!track) {
        return root;
      }
      return {
        ...root,
        expandedAlbums: [...new Set([...root.expandedAlbums, ...collectFolderPaths([track])])],
        activeRowKey: `track:${track.id}`
      };
    })
  );
}

