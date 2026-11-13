// Actions on the open folders ("roots"): open, restore and resync one
// (hydrateRoot), choose one, close one, and show the playing queue in it.
// They write the `library` store; the views read it.

import { $toRaw } from "jq79";
import type { SampleList } from "../helpers/samples";
import { emptyMetadata, readsEveryField, withEveryField } from "../helpers/metadata";
import { isAudioFile } from "../helpers/formats";
import { isPlaylistFile } from "../helpers/playlists";
import { applyScanResults, checksumOf, omitRecords, type ScanResult } from "../helpers/snapshot";
import { collectFolderPaths } from "../helpers/tracks";
import type { GroupingMode, LibraryView, RootSource, RootWorkspace, Track } from "../types";
import { coversIn, internSnapshot, namesIn, withCovers } from "./covers";
import { refName } from "../helpers/cover";
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
  given: RootSource,
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
  forgetRecent(given.saved);
  // Its tags with their covers by reference, each picture kept once (lib/covers.ts).
  const source = withCovers(given);
  const vfs = source.vfs;
  const rootId = options.rootId ?? `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const rootLabel = options.rootLabel ?? (vfs.name || t("roots.fallbackName", { number: $toRaw(library).roots.length + 1 }));
  const groupingMode = options.groupingMode ?? "wizard";

  // ─── Phase 1: Snapshot → instant render ──────────────────────────────────
  // An older `.meta/` holds each track's cover whole: taken by reference, and written again so.
  const { snapshot, changed: olderSnapshot } = internSnapshot(await readMetaSnapshot(vfs));

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
    metadata: withEveryField(stored.metadata)
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
      // The covers the snapshot names, looked for in `.meta/covers/`: a track whose picture is not
      // there has its tags read again.
      const [walked, missingCovers] = await Promise.all([source.walk(), coversIn(vfs, namesIn(snapshot))]);
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
        // Kept before the disc, album artist and compilation were read: read again, for them.
        if (!stored) return false;
        const cover = refName(stored.metadata.coverDataUrl);
        return stored.size !== f.size || stored.lastModified !== f.lastModified || !readsEveryField(stored.metadata) || (cover !== null && missingCovers.has(cover));
      });

      const staleOrNewFiles = [...newFiles, ...modifiedFiles];
      const isFullyCached = staleOrNewFiles.length === 0 && removedPaths.length === 0;
      // Read in bulk (the desktop app), a new file comes in with its tags, a batch at a time: no
      // empty row first, which drew the whole library once more for nothing.
      const bulk = !!source.scanTags;
      const adding = new Set(bulk ? newFiles.map((file) => file.relativePath) : []);

      // Drop tracks that are gone from disk
      updateRoots((currentRoots) =>
        currentRoots.map((root) => {
          if (root.id !== rootId) {
            return root;
          }

          const removed = new Set(removedPaths);
          const tracks = root.tracks.filter((t) => !removed.has(t.relativePath));

          // Add genuinely new files (not in snapshot at all) as empty placeholder tracks
          for (const file of bulk ? [] : newFiles) {
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
            loadedCount: audioFiles.length - staleOrNewFiles.length,
            total: audioFiles.length
          };
        })
      );

      if (isFullyCached) {
        // An older `.meta/` is written again with its covers by reference.
        if (olderSnapshot) await flushMeta(rootId).catch(() => undefined);
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
      let snapshotDirty = removedPaths.length > 0 || olderSnapshot;

      function flush(): void {
        const updates = [...pendingUpdates];
        pendingUpdates.length = 0;

        updateRoots((currentRoots) =>
          currentRoots.map((root) =>
            root.id === rootId
              ? { ...applyScanResults(root, updates, adding), loadedCount, loadingMetadata: loadedCount < totalAfterWalk }
              : root
          )
        );
      }

      const READ_CONCURRENCY = 6;
      const FLUSH_EVERY_MS = 400;
      let flushedAt = Date.now();
      let cursor = 0;
      let failedCount = 0;

      // The checksum a track has in the library now, or "" when it is gone: through a map of the
      // root's tracks, made again only when they change (a find on each file was quadratic).
      let indexed: { tracks: readonly Track[]; byId: Map<string, Track> } | null = null;
      function checksumNow(trackId: string): string {
        const tracks = $toRaw(library).roots.find((root) => root.id === rootId)?.tracks ?? [];
        if (indexed?.tracks !== tracks) indexed = { tracks, byId: new Map(tracks.map((item) => [item.id, item])) };
        const track = indexed.byId.get(trackId);
        return track ? checksumOf(track) : "";
      }

      // Reads one file's checksums and tags into the next flush.
      async function readOne(file: (typeof staleOrNewFiles)[number]): Promise<void> {
        const readFrom = checksumNow(file.relativePath);
        const stored = snapshot.tracks[file.relativePath];
        // With no checksum to compare, the tags come back even when the file has not changed; so
        // too when its cover is missing from `.meta/covers/`.
        const coverGone = missingCovers.has(refName(stored?.metadata.coverDataUrl) ?? "");
        const known = stored && readsEveryField(stored.metadata) && !coverGone ? stored.fullChecksum || stored.checksum : undefined;
        const found = await source.inspect(file.relativePath, known);
        const { fullChecksum, audioChecksum } = found;
        const metadata = withEveryField(found.metadata ?? stored?.metadata ?? emptyMetadata());

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

      // In bulk where the source can (the desktop app: src-tauri/src/scan.rs): every file's tags in
      // one call, from their heads, in batches; their checksums after, in the background
      // (lib/verifier.ts), so the library shows whole without the audio read. Elsewhere, each file
      // inspected, several at once.
      async function inBulk(scanTags: NonNullable<RootSource["scanTags"]>): Promise<void> {
        const readFrom = new Map(staleOrNewFiles.map((file) => [file.relativePath, checksumNow(file.relativePath)]));
        await scanTags(
          staleOrNewFiles.map((file) => file.relativePath),
          [],
          (batch) => {
            const nowIso = new Date().toISOString();
            for (const found of batch.tracks) {
              pendingUpdates.push({
                trackId: found.path,
                readFrom: readFrom.get(found.path) ?? "",
                record: {
                  // No checksum yet: the verifier works them out next.
                  checksum: "",
                  fullChecksum: "",
                  audioChecksum: "",
                  size: found.size,
                  lastModified: found.lastModified,
                  lastVerifiedAt: undefined,
                  metadata: withEveryField(found.metadata),
                  updatedAt: nowIso
                }
              });
            }
            for (const unread of batch.unread) console.error(`jackbird: could not read ${unread.path}`, unread.message);
            failedCount += batch.unread.length;
            loadedCount += batch.tracks.length + batch.unread.length;
            snapshotDirty ||= batch.tracks.length > 0;
            if (batch.done || Date.now() - flushedAt >= FLUSH_EVERY_MS) {
              flushedAt = Date.now();
              flush();
            }
          }
        );
      }

      if (source.scanTags) {
        await inBulk(source.scanTags);
      } else {
        await Promise.all(
          Array.from({ length: Math.min(READ_CONCURRENCY, staleOrNewFiles.length) }, () => worker())
        );
      }

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
      // A folder the browser can only read (lib/sources/picked.ts): said once it is open.
      if (source.readOnly) library.infoMessage = t("message.readOnlyOpened");
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
  // Offered again in "Add to the library…"'s Folder tab; not a folder read only, which cannot be reopened.
  if (!roots[index].source.readOnly) rememberClosed({ label: roots[index].label, saved: roots[index].source.saved });

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

