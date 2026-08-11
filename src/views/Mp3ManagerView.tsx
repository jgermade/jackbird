import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { AlbumOverview } from "../components/AlbumOverview";
import { DetailActionBar } from "../components/DetailActionBar";
import { FolderPicker } from "../components/FolderPicker";
import { LibraryLanding } from "../components/LibraryLanding";
import { MetadataEditModal } from "../components/MetadataEditModal";
import { PlaybackBar } from "../components/PlaybackBar";
import { PreferencesModal } from "../components/PreferencesModal";
import { RootTabs } from "../components/RootTabs";
import { TrackInfoModal } from "../components/TrackInfoModal";
import { TrackWizardList, type WizardTreeRow } from "../components/TrackWizardList";
import {
  calculateDualChecksums,
  readTrackMetadataFromBytes,
  writeTrackMetadataToBytes
} from "../lib/id3";
import { loadRootSession, saveRootSession } from "../lib/rootSessionStore";
import { useTheme } from "../services/ThemeService";
import type { EditableMetadata, Mp3Track, TrackMetadata } from "../types";
import { BrowserVfs } from "../vfs/browserVfs";


type GroupingMode = "flat" | "wizard";

type MetaRecord = {
  checksum: string;
  fullChecksum?: string;
  audioChecksum?: string;
  size?: number;
  lastModified?: number;
  lastVerifiedAt?: string;
  metadata: TrackMetadata;
  updatedAt: string;
};

type MetaSnapshot = {
  version: 1;
  tracks: Record<string, MetaRecord>;
};

type PlaybackQueue = {
  rootId: string;
  trackIds: string[];
  sourceLabel: string;
};

type RootWorkspace = {
  id: string;
  label: string;
  vfs: BrowserVfs;
  tracks: Mp3Track[];
  selectedTrackId: string | null;
  selectedTrackIds: string[];
  selectionAnchorTrackId: string | null;
  draft: EditableMetadata;
  loadingMetadata: boolean;
  loadedCount: number;
  groupingMode: GroupingMode;
  metaSnapshot: MetaSnapshot;
  expandedAlbums: string[];
  expandedDiscs: string[];
  activeRowKey: string | null;
};

const META_FILE_PATH = ".meta/mp3-manager.json";

function emptyMetadata(): TrackMetadata {
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

function emptySnapshot(): MetaSnapshot {
  return {
    version: 1,
    tracks: {}
  };
}

export function Mp3ManagerView(): JSX.Element {
  const [theme, toggleTheme] = useTheme();
  const [roots, setRoots] = useState<RootWorkspace[]>([]);
  const [activeRootId, setActiveRootId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [restoring, setRestoring] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [infoMessage, setInfoMessage] = useState<string | null>(null);
  const [playbackQueue, setPlaybackQueue] = useState<PlaybackQueue | null>(null);
  const [playbackIndex, setPlaybackIndex] = useState(0);
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [infoModalOpen, setInfoModalOpen] = useState(false);
  const [isAudioPlaying, setIsAudioPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement>(null);

  const activeRoot = useMemo(
    () => roots.find((root) => root.id === activeRootId) ?? null,
    [roots, activeRootId]
  );



  const selectedTracks = useMemo(() => {
    if (!activeRoot || activeRoot.selectedTrackIds.length === 0) {
      return [];
    }
    const set = new Set(activeRoot.selectedTrackIds);
    return activeRoot.tracks.filter((track) => set.has(track.id));
  }, [activeRoot]);

  const treeRows = useMemo(() => buildWizardRows(activeRoot?.tracks ?? [], activeRoot), [activeRoot]);

  const rowByKey = useMemo(
    () => new Map(treeRows.map((row) => [row.key, row])),
    [treeRows]
  );

  const detailScope = useMemo(() => {
    if (!activeRoot) {
      return { label: "", tracks: [] as Mp3Track[] };
    }

    const row = activeRoot.activeRowKey ? rowByKey.get(activeRoot.activeRowKey) : undefined;
    if (row?.kind === "album") {
      return {
        label: row.label,
        tracks: activeRoot.tracks.filter((track) => track.relativePath.startsWith(`${row.album}/`))
      };
    }

    if (row?.kind === "disc" && row.disc) {
      return {
        label: `${row.album} - ${row.disc}`,
        tracks: activeRoot.tracks.filter(
          (track) =>
            (track.metadata.album.trim() || "Sin album") === row.album && inferDiscLabel(track) === row.disc
        )
      };
    }

    if (row?.kind === "track" && row.album) {
      return {
        label: row.album,
        tracks: activeRoot.tracks.filter((track) => track.relativePath.startsWith(`${row.album}/`))
      };
    }

    return { label: activeRoot.label, tracks: activeRoot.tracks };
  }, [activeRoot, rowByKey]);

  const detailTracks = detailScope.tracks;
  const detailLabel = detailScope.label;

  const playbackRoot = useMemo(
    () => roots.find((root) => root.id === playbackQueue?.rootId) ?? null,
    [roots, playbackQueue]
  );
  const playbackTracks = useMemo(() => {
    if (!playbackQueue || !playbackRoot) {
      return [] as Mp3Track[];
    }

    const tracksById = new Map(playbackRoot.tracks.map((track) => [track.id, track]));
    return playbackQueue.trackIds.flatMap((trackId) => {
      const track = tracksById.get(trackId);
      return track ? [track] : [];
    });
  }, [playbackQueue, playbackRoot]);
  const playbackTrack = playbackTracks[playbackIndex] ?? null;

  useEffect(() => {
    let cancelled = false;

    async function restoreSession(): Promise<void> {
      try {
        const session = await loadRootSession();
        const restoredRootIds: string[] = [];

        for (const persistedRoot of session.roots) {
          if (cancelled) {
            break;
          }

          const vfs = new BrowserVfs();
          await vfs.mountFromHandle(persistedRoot.handle);
          const hasPermission = await vfs.hasReadWritePermission();

          if (!hasPermission) {
            continue;
          }

          await hydrateRoot(vfs, {
            rootId: persistedRoot.id,
            rootLabel: persistedRoot.label,
            groupingMode: persistedRoot.groupingMode,
            setActive: false
          });
          restoredRootIds.push(persistedRoot.id);
        }

        if (!cancelled) {
          if (session.activeRootId && restoredRootIds.includes(session.activeRootId)) {
            setActiveRootId(session.activeRootId);
          } else if (restoredRootIds.length > 0) {
            setActiveRootId(restoredRootIds[0]);
          }
        }
      } catch {
        // Ignore restore errors and allow clean startup.
      } finally {
        if (!cancelled) {
          setRestoring(false);
        }
      }
    }

    void restoreSession();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (restoring) {
      return;
    }

    const rootsForSession = roots
      .map((root) => {
        const handle = root.vfs.getRootHandle();
        if (!handle) {
          return null;
        }

        return {
          id: root.id,
          label: root.label,
          handle,
          groupingMode: root.groupingMode
        };
      })
      .filter((value): value is NonNullable<typeof value> => value !== null);

    void saveRootSession({
      roots: rootsForSession,
      activeRootId
    });
  }, [roots, activeRootId, restoring]);

  useEffect(() => {
    if (!activeRoot || activeRoot.loadingMetadata || activeRoot.tracks.length === 0) {
      return;
    }

    let cancelled = false;

    async function runBackgroundVerifier(): Promise<void> {
      if (!activeRoot) {
        return;
      }

      const tracksToVerify = [...activeRoot.tracks].sort((a, b) => {
        if (!a.audioChecksum && b.audioChecksum) return -1;
        if (a.audioChecksum && !b.audioChecksum) return 1;
        const timeA = a.lastVerifiedAt ? new Date(a.lastVerifiedAt).getTime() : 0;
        const timeB = b.lastVerifiedAt ? new Date(b.lastVerifiedAt).getTime() : 0;
        return timeA - timeB;
      });

      const now = Date.now();
      const ONE_DAY_MS = 24 * 60 * 60 * 1000;
      const candidates = tracksToVerify.filter((t) => {
        if (!t.audioChecksum || !t.lastVerifiedAt) return true;
        return now - new Date(t.lastVerifiedAt).getTime() > ONE_DAY_MS;
      });

      if (candidates.length === 0) {
        return;
      }

      let modifiedCount = 0;
      const currentSnapshot = activeRoot.metaSnapshot;

      for (const track of candidates) {
        if (cancelled) {
          break;
        }

        await new Promise((r) => setTimeout(r, 300));
        if (cancelled) {
          break;
        }

        try {
          const sourceBytes = await activeRoot.vfs.readFile(track.vfsFileId);
          const { fullChecksum, audioChecksum } = await calculateDualChecksums(sourceBytes);
          const nowIso = new Date().toISOString();

          currentSnapshot.tracks[track.relativePath] = {
            checksum: fullChecksum,
            fullChecksum,
            audioChecksum,
            size: track.size,
            lastModified: track.lastModified,
            lastVerifiedAt: nowIso,
            metadata: track.metadata,
            updatedAt: currentSnapshot.tracks[track.relativePath]?.updatedAt ?? nowIso
          };

          modifiedCount += 1;

          setRoots((currentRoots) =>
            currentRoots.map((r) => {
              if (r.id !== activeRoot.id) return r;
              return {
                ...r,
                tracks: r.tracks.map((t) =>
                  t.id === track.id
                    ? {
                        ...t,
                        checksum: fullChecksum,
                        fullChecksum,
                        audioChecksum,
                        lastVerifiedAt: nowIso
                      }
                    : t
                ),
                metaSnapshot: currentSnapshot
              };
            })
          );

          if (modifiedCount % 10 === 0) {
            await writeMetaSnapshot(activeRoot.vfs, currentSnapshot);
          }
        } catch {
          // Ignore individual background read errors
        }
      }

      if (modifiedCount > 0 && !cancelled) {
        await writeMetaSnapshot(activeRoot.vfs, currentSnapshot);
      }
    }

    const timer = setTimeout(() => {
      void runBackgroundVerifier();
    }, 3000);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [activeRoot?.id, activeRoot?.loadingMetadata]);

  async function hydrateRoot(
    vfs: BrowserVfs,
    options: {
      rootId?: string;
      rootLabel?: string;
      groupingMode?: GroupingMode;
      setActive?: boolean;
    } = {}
  ): Promise<void> {
    const rootId = options.rootId ?? `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const rootLabel = options.rootLabel ?? (vfs.getRootName() || `Root ${roots.length + 1}`);
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
      vfsFileId: relativePath, // placeholder until walk resolves real VfsFile id
      checksum: stored.fullChecksum || stored.checksum,
      fullChecksum: stored.fullChecksum || stored.checksum,
      audioChecksum: stored.audioChecksum,
      lastVerifiedAt: stored.lastVerifiedAt,
      metadata: stored.metadata
    }));

    setRoots((currentRoots) => {
      const existingIndex = currentRoots.findIndex((root) => root.id === rootId);
      const nextRoot: RootWorkspace = {
        id: rootId,
        label: rootLabel,
        vfs,
        tracks: initialTracks,
        selectedTrackId: null,
        selectedTrackIds: [],
        selectionAnchorTrackId: null,
        draft: emptyMetadata(),
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
      setActiveRootId(rootId);
    }

    // ─── Phase 2: Filesystem walk (background) ────────────────────────────────
    void (async () => {
      try {
        const mp3Files = await vfs.listFiles({ extensions: [".mp3"] });

        // Update vfsFileId for all existing tracks now that we have real VfsFile entries
        const fileByPath = new Map(mp3Files.map((f) => [f.relativePath, f]));
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

        // Apply vfsFileId updates and remove deleted tracks
        setRoots((currentRoots) =>
          currentRoots.map((root) => {
            if (root.id !== rootId) {
              return root;
            }

            let tracks = root.tracks
              .filter((t) => !removedPaths.includes(t.relativePath))
              .map((t) => {
                const file = fileByPath.get(t.relativePath);
                return file ? { ...t, vfsFileId: file.id } : t;
              });

            // Add genuinely new files (not in snapshot at all) as empty placeholder tracks
            for (const file of newFiles) {
              tracks.push({
                id: file.relativePath,
                name: file.name,
                relativePath: file.relativePath,
                size: file.size,
                lastModified: file.lastModified,
                vfsFileId: file.id,
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
          setRoots((currentRoots) =>
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
        let loadedCount = initialTracks.length - staleOrNewFiles.length + (removedPaths.length > 0 ? 0 : 0);
        let snapshotDirty = removedPaths.length > 0;
        const totalAfterWalk = mp3Files.length;

        function flush(): void {
          const updates = [...pendingUpdates];
          pendingUpdates.length = 0;

          setRoots((currentRoots) =>
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

        async function worker(): Promise<void> {
          while (true) {
            const itemIndex = cursor;
            cursor += 1;
            if (itemIndex >= staleOrNewFiles.length) {
              return;
            }

            const file = staleOrNewFiles[itemIndex];
            const sourceBytes = await vfs.readFile(file.id);
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

        setRoots((currentRoots) =>
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
      } catch {
        // Walk failed silently — snapshot data is still usable
        setRoots((currentRoots) =>
          currentRoots.map((root) =>
            root.id === rootId ? { ...root, loadingMetadata: false } : root
          )
        );
      }
    })();
  }




  async function handlePickFolder(): Promise<void> {
    setLoading(true);
    setErrorMessage(null);
    setInfoMessage(null);

    try {
      const vfs = new BrowserVfs();
      await vfs.mount();
      await hydrateRoot(vfs);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "No se pudo escanear la carpeta seleccionada.");
    } finally {
      setLoading(false);
    }
  }

  function handleSelectTrack(
    trackId: string,
    options?: boolean | { toggle?: boolean; extendRange?: boolean }
  ): void {
    if (!activeRootId) {
      return;
    }

    const extendRange = typeof options === "object" ? Boolean(options.extendRange) : Boolean(options);
    const toggle = typeof options === "object" ? (options.toggle !== undefined ? options.toggle : !extendRange) : !extendRange;

    const visibleTrackIds = treeRows.flatMap((row) => (row.kind === "track" && row.trackId ? [row.trackId] : []));
    const orderedTrackIds = visibleTrackIds.length > 0 ? visibleTrackIds : (activeRoot?.tracks.map((t) => t.id) ?? []);

    setRoots((currentRoots) =>
      currentRoots.map((root) => {
        if (root.id !== activeRootId) {
          return root;
        }

        let selectedTrackIds: string[];

        if (toggle) {
          const exists = root.selectedTrackIds.includes(trackId);
          if (exists) {
            selectedTrackIds = root.selectedTrackIds.filter((id) => id !== trackId);
          } else {
            selectedTrackIds = [...root.selectedTrackIds, trackId];
          }
        } else if (extendRange) {
          const anchorId = root.selectionAnchorTrackId ?? root.selectedTrackIds[0] ?? trackId;
          const anchorIndex = orderedTrackIds.indexOf(anchorId);
          const targetIndex = orderedTrackIds.indexOf(trackId);
          if (anchorIndex !== -1 && targetIndex !== -1) {
            const start = Math.min(anchorIndex, targetIndex);
            const end = Math.max(anchorIndex, targetIndex);
            const range = orderedTrackIds.slice(start, end + 1);
            selectedTrackIds = Array.from(new Set([...root.selectedTrackIds, ...range]));
          } else {
            selectedTrackIds = [trackId];
          }
        } else {
          selectedTrackIds = [trackId];
        }

        const singleSelection = selectedTrackIds.length === 1;
        const activeTrackId = singleSelection ? selectedTrackIds[0] : trackId;
        const trackObj = root.tracks.find((item) => item.id === activeTrackId);

        return {
          ...root,
          selectedTrackId: singleSelection ? activeTrackId : null,
          selectedTrackIds,
          selectionAnchorTrackId: toggle
            ? root.selectionAnchorTrackId ?? trackId
            : extendRange
            ? root.selectionAnchorTrackId ?? trackId
            : trackId,
          activeRowKey: `track:${activeTrackId}`,
          draft: singleSelection ? trackObj?.metadata ?? emptyMetadata() : emptyMetadata()
        };
      })
    );

    setInfoMessage(null);
    setErrorMessage(null);
  }

  function handleClearSelection(): void {
    if (!activeRootId) {
      return;
    }
    setRoots((currentRoots) =>
      currentRoots.map((root) =>
        root.id === activeRootId
          ? {
              ...root,
              selectedTrackId: null,
              selectedTrackIds: [],
              selectionAnchorTrackId: null,
              draft: emptyMetadata()
            }
          : root
      )
    );
  }

  function handleDeleteSelectedTracks(): void {
    if (!activeRoot || activeRoot.selectedTrackIds.length === 0) {
      return;
    }

    const count = activeRoot.selectedTrackIds.length;
    const message =
      count === 1
        ? "¿Estás seguro de que deseas quitar esta pista de la biblioteca?"
        : `¿Estás seguro de que deseas quitar las ${count} pistas seleccionadas de la biblioteca?`;

    if (!window.confirm(message)) {
      return;
    }

    const toRemove = new Set(activeRoot.selectedTrackIds);
    setRoots((currentRoots) =>
      currentRoots.map((root) => {
        if (root.id !== activeRoot.id) {
          return root;
        }
        return {
          ...root,
          tracks: root.tracks.filter((track) => !toRemove.has(track.id)),
          selectedTrackId: null,
          selectedTrackIds: [],
          selectionAnchorTrackId: null,
          draft: emptyMetadata()
        };
      })
    );

    setInfoMessage(count === 1 ? "Pista eliminada de la biblioteca." : `${count} pistas eliminadas de la biblioteca.`);
  }

  function handlePlayVisibleTrack(trackId: string): void {
    if (!activeRoot || detailTracks.length === 0) {
      return;
    }

    if (playbackTrack?.id === trackId && audioRef.current) {
      if (audioRef.current.paused) {
        void audioRef.current.play();
      } else {
        audioRef.current.pause();
      }
      return;
    }

    const trackIds = orderDetailPlaylist(detailTracks).map((track) => track.id);
    const index = trackIds.indexOf(trackId);
    if (index === -1) {
      return;
    }

    setPlaybackQueue({ rootId: activeRoot.id, trackIds, sourceLabel: detailLabel });
    setPlaybackIndex(index);
  }

  function handlePreviousPlaybackTrack(): void {
    setPlaybackIndex((index) => Math.max(0, index - 1));
  }

  function handleNextPlaybackTrack(): void {
    setPlaybackIndex((index) => Math.min(playbackTracks.length - 1, index + 1));
  }

  function handleReturnToPlaybackList(): void {
    if (!playbackQueue) {
      return;
    }

    setActiveRootId(playbackQueue.rootId);
    setRoots((currentRoots) =>
      currentRoots.map((root) =>
        root.id === playbackQueue.rootId
          ? {
              ...root,
              selectedTrackId: null,
              selectedTrackIds: playbackQueue.trackIds,
              selectionAnchorTrackId: null,
              activeRowKey: null,
              draft: emptyMetadata()
            }
          : root
      )
    );
  }

  function handleSelectRoot(rootId: string): void {
    setActiveRootId(rootId);
    setInfoMessage(null);
    setErrorMessage(null);

    void resyncRootIfNeeded(rootId);
  }

  async function resyncRootIfNeeded(rootId: string): Promise<void> {
    const root = roots.find((item) => item.id === rootId);
    if (!root || root.loadingMetadata) {
      return;
    }

    const currentFiles = await root.vfs.listFiles({ extensions: [".mp3"] });
    const currentPaths = new Set(currentFiles.map((file) => file.relativePath));
    const knownPaths = new Set(root.tracks.map((track) => track.relativePath));

    if (currentFiles.length === root.tracks.length && [...currentPaths].every((path) => knownPaths.has(path))) {
      return;
    }

    setInfoMessage(`Resincronizando root ${root.label}...`);
    await hydrateRoot(root.vfs, {
      rootId: root.id,
      rootLabel: root.label,
      groupingMode: root.groupingMode,
      setActive: false
    });
  }

  function handleCloseRoot(rootId: string): void {
    if (playbackQueue?.rootId === rootId) {
      setPlaybackQueue(null);
      setPlaybackIndex(0);
    }

    setRoots((currentRoots) => {
      const index = currentRoots.findIndex((root) => root.id === rootId);
      if (index === -1) {
        return currentRoots;
      }

      const nextRoots = currentRoots.filter((root) => root.id !== rootId);

      if (activeRootId === rootId) {
        const fallback = nextRoots[index] ?? nextRoots[index - 1] ?? null;
        setActiveRootId(fallback?.id ?? null);
      }

      return nextRoots;
    });
  }

  function handleChangeDraft(next: EditableMetadata): void {
    if (!activeRootId) {
      return;
    }

    setRoots((currentRoots) =>
      currentRoots.map((root) =>
        root.id === activeRootId
          ? {
              ...root,
              draft: next
            }
          : root
      )
    );
  }

  function handleToggleAlbum(album: string): void {
    if (!activeRootId) {
      return;
    }

    setRoots((currentRoots) =>
      currentRoots.map((root) => {
        if (root.id !== activeRootId) {
          return root;
        }

        const already = root.expandedAlbums.includes(album);
        return {
          ...root,
          expandedAlbums: already
            ? root.expandedAlbums.filter((value) => value !== album)
            : [...root.expandedAlbums, album]
        };
      })
    );
  }

  function handleToggleDisc(album: string, disc: string): void {
    if (!activeRootId) {
      return;
    }

    const key = `${album}::${disc}`;

    setRoots((currentRoots) =>
      currentRoots.map((root) => {
        if (root.id !== activeRootId) {
          return root;
        }

        const already = root.expandedDiscs.includes(key);
        return {
          ...root,
          expandedDiscs: already
            ? root.expandedDiscs.filter((value) => value !== key)
            : [...root.expandedDiscs, key]
        };
      })
    );
  }

  function handleExpandAllFolders(): void {
    if (!activeRootId || !activeRoot) {
      return;
    }

    const albums = collectFolderPaths(activeRoot.tracks);

    setRoots((currentRoots) =>
      currentRoots.map((root) =>
        root.id === activeRootId
          ? {
              ...root,
              expandedAlbums: albums
            }
          : root
      )
    );
  }

  function handleCollapseAllFolders(): void {
    if (!activeRootId) {
      return;
    }

    setRoots((currentRoots) =>
      currentRoots.map((root) =>
        root.id === activeRootId
          ? {
              ...root,
              expandedAlbums: [],
              expandedDiscs: []
            }
          : root
      )
    );
  }

  function handleSelectTreeRow(rowKey: string): void {
    if (!activeRootId) {
      return;
    }

    setRoots((currentRoots) =>
      currentRoots.map((root) => {
        if (root.id !== activeRootId) {
          return root;
        }

        return {
          ...root,
          activeRowKey: rowKey,
          selectedTrackId: null,
          selectedTrackIds: [],
          selectionAnchorTrackId: null,
          draft: emptyMetadata()
        };
      })
    );

    const row = rowByKey.get(rowKey);
    if (row?.kind === "track" && row.trackId) {
      handleSelectTrack(row.trackId);
    }
  }

  function handleConsolidateTrack(_trackId: string): void {
    setInfoMessage(
      "Consolidar: pendiente de definir el patron de nombre (estilo mp3tag). Boton de marcador por ahora."
    );
  }

  async function handleLoadPlaybackAudioBytes(track: Mp3Track): Promise<Uint8Array> {
    if (!playbackRoot) {
      throw new Error("La carpeta de la lista de reproduccion ya no esta disponible.");
    }

    return playbackRoot.vfs.readFile(track.vfsFileId);
  }

  function handleLibraryKeyDown(event: KeyboardEvent<HTMLElement>): void {
    if (!activeRoot || activeRoot.groupingMode !== "wizard" || treeRows.length === 0) {
      return;
    }

    if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) {
      return;
    }

    event.preventDefault();

    const currentIndex = treeRows.findIndex((row) => row.key === activeRoot.activeRowKey);
    const index = currentIndex === -1 ? 0 : currentIndex;
    const currentRow = treeRows[index];

    if (event.key === "ArrowUp") {
      const next = treeRows[Math.max(0, index - 1)];
      handleSelectTreeRow(next.key);
      return;
    }

    if (event.key === "ArrowDown") {
      const next = treeRows[Math.min(treeRows.length - 1, index + 1)];
      handleSelectTreeRow(next.key);
      return;
    }

    if (event.key === "ArrowRight") {
      if (currentRow.kind === "album" && !currentRow.expanded) {
        handleToggleAlbum(currentRow.album);
        return;
      }

      if (currentRow.kind === "disc" && !currentRow.expanded && currentRow.disc) {
        handleToggleDisc(currentRow.album, currentRow.disc);
        return;
      }

      const next = treeRows[Math.min(treeRows.length - 1, index + 1)];
      handleSelectTreeRow(next.key);
      return;
    }

    if (event.key === "ArrowLeft") {
      if (currentRow.kind === "disc" && currentRow.expanded && currentRow.disc) {
        handleToggleDisc(currentRow.album, currentRow.disc);
        return;
      }

      if (currentRow.kind === "album" && currentRow.expanded) {
        handleToggleAlbum(currentRow.album);
        return;
      }

      if (currentRow.parentKey) {
        handleSelectTreeRow(currentRow.parentKey);
      }
    }
  }

  function handleOpenEditModal(): void {
    if (selectedTracks.length === 0 || !activeRootId) {
      return;
    }

    const commonDraft = computeCommonMetadata(selectedTracks);
    setRoots((currentRoots) =>
      currentRoots.map((root) =>
        root.id === activeRootId
          ? {
              ...root,
              draft: commonDraft
            }
          : root
      )
    );
    setEditModalOpen(true);
  }

  async function handleSave(): Promise<void> {
    if (!activeRoot || selectedTracks.length === 0) {
      return;
    }

    setSaving(true);
    setErrorMessage(null);
    setInfoMessage(null);

    try {
      const draft = activeRoot.draft;
      const varied = getVariedFields(selectedTracks);
      const nextSnapshotTracks = { ...activeRoot.metaSnapshot.tracks };
      const updatedTrackMap = new Map(activeRoot.tracks.map((t) => [t.id, t]));

      for (const track of selectedTracks) {
        const nextMeta: TrackMetadata = {
          title: varied.title && !draft.title ? track.metadata.title : draft.title,
          artist: varied.artist && !draft.artist ? track.metadata.artist : draft.artist,
          album: varied.album && !draft.album ? track.metadata.album : draft.album,
          year: varied.year && !draft.year ? track.metadata.year : draft.year,
          genre: varied.genre && !draft.genre ? track.metadata.genre : draft.genre,
          trackNumber: varied.trackNumber && !draft.trackNumber ? track.metadata.trackNumber : draft.trackNumber,
          coverDataUrl: varied.coverDataUrl && draft.coverDataUrl === null ? track.metadata.coverDataUrl : draft.coverDataUrl
        };

        const sourceBytes = await activeRoot.vfs.readFile(track.vfsFileId);
        const nextBytes = await writeTrackMetadataToBytes(sourceBytes, nextMeta);
        await activeRoot.vfs.writeFile(track.vfsFileId, nextBytes);
        const { fullChecksum, audioChecksum } = await calculateDualChecksums(nextBytes);
        const nowIso = new Date().toISOString();
        const lastMod = Date.now();

        nextSnapshotTracks[track.relativePath] = {
          checksum: fullChecksum,
          fullChecksum,
          audioChecksum,
          size: nextBytes.byteLength,
          lastModified: lastMod,
          lastVerifiedAt: nowIso,
          metadata: nextMeta,
          updatedAt: nowIso
        };

        updatedTrackMap.set(track.id, {
          ...track,
          checksum: fullChecksum,
          fullChecksum,
          audioChecksum,
          size: nextBytes.byteLength,
          lastModified: lastMod,
          lastVerifiedAt: nowIso,
          metadata: nextMeta
        });
      }

      const nextSnapshot: MetaSnapshot = {
        ...activeRoot.metaSnapshot,
        tracks: nextSnapshotTracks
      };

      await writeMetaSnapshot(activeRoot.vfs, nextSnapshot);

      const writeCount = activeRoot.vfs.getWriteOperations().length;

      setRoots((currentRoots) =>
        currentRoots.map((root) => {
          if (root.id !== activeRoot.id) {
            return root;
          }

          return {
            ...root,
            metaSnapshot: nextSnapshot,
            tracks: root.tracks.map((item) => updatedTrackMap.get(item.id) ?? item)
          };
        })
      );

      const trackLabel = selectedTracks.length === 1 ? selectedTracks[0].name : `${selectedTracks.length} pistas`;
      setInfoMessage(`Metadatos guardados en ${trackLabel}. Operaciones VFS en tab: ${writeCount}.`);
      setEditModalOpen(false);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "No se pudieron guardar los cambios.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="app-shell">
      <header className="app-topbar">
        <div className="header-left">
          <h1 className="brand">MP3 Manager</h1>
          <FolderPicker onPickFolder={handlePickFolder} disabled={loading} loading={loading} hasRoots={roots.length > 0} />
        </div>

        <div className="header-right">
          <RootTabs
            tabs={roots.map((root) => ({
              id: root.id,
              label: root.label,
              count: root.tracks.length,
              loadingMetadata: root.loadingMetadata,
              loadedCount: root.loadedCount
            }))}
            activeTabId={activeRootId}
            onSelectTab={handleSelectRoot}
            onCloseTab={handleCloseRoot}
          />

          <div className="header-right-actions">
            <PlaybackBar
              track={playbackTrack}
              trackKey={playbackTrack && playbackQueue ? `${playbackQueue.rootId}:${playbackTrack.id}` : null}
              sourceLabel={playbackQueue?.sourceLabel ?? "Lista"}
              position={playbackIndex}
              total={playbackTracks.length}
              canGoPrevious={playbackIndex > 0}
              canGoNext={playbackIndex < playbackTracks.length - 1}
              onLoadAudioBytes={handleLoadPlaybackAudioBytes}
              onPrevious={handlePreviousPlaybackTrack}
              onNext={handleNextPlaybackTrack}
              onReturnToList={handleReturnToPlaybackList}
              onPlaybackStateChange={setIsAudioPlaying}
              audioRef={audioRef}
            />
            <button
              type="button"
              className="preferences-trigger"
              onClick={() => setPreferencesOpen(true)}
              aria-label="Abrir preferencias"
              title="Preferencias"
            >
              &#9881;
            </button>
          </div>
        </div>
      </header>

      <section className="app-body">
        <aside className="library-pane" onKeyDown={handleLibraryKeyDown} tabIndex={0}>
          <div className="library-head">
            <div className="library-head-title">
              <h2>Biblioteca</h2>
              <span className="library-head-count">{activeRoot?.tracks.length ?? 0}</span>
            </div>
            <div className="library-head-actions">
              <button
                type="button"
                className="library-head-btn"
                onClick={handleExpandAllFolders}
                disabled={!activeRoot || activeRoot.tracks.length === 0}
                title="Expandir todo"
                aria-label="Expandir todo"
              >
                <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                  <path
                    d="M3 5.5h10M3 10.5h10M8 3v5M8 8v5"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.4"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
              <button
                type="button"
                className="library-head-btn"
                onClick={handleCollapseAllFolders}
                disabled={!activeRoot || activeRoot.expandedAlbums.length === 0}
                title="Colapsar todo"
                aria-label="Colapsar todo"
              >
                <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                  <path
                    d="M3 5.5h10M3 10.5h10"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.4"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
            </div>
          </div>

          {(errorMessage || infoMessage || restoring) && (
            <section className="panel-message">
              {restoring && <p className="message info">Restaurando tabs...</p>}
              {errorMessage && <p className="message error">{errorMessage}</p>}
              {infoMessage && <p className="message info">{infoMessage}</p>}
            </section>
          )}

          {activeRoot?.loadingMetadata && (
            <p className="library-loading-status">
              Cargando metadatos {activeRoot.loadedCount}/{activeRoot.tracks.length}...
            </p>
          )}

          <TrackWizardList
            rows={treeRows}
            selectedTrackIds={activeRoot?.selectedTrackIds ?? []}
            activeRowKey={activeRoot?.activeRowKey ?? null}
            onSelectTrack={handleSelectTrack}
            onSelectRow={handleSelectTreeRow}
            onToggleAlbum={handleToggleAlbum}
            onToggleDisc={handleToggleDisc}
            onConsolidateTrack={handleConsolidateTrack}
            loadingMetadata={Boolean(activeRoot?.loadingMetadata)}
          />
        </aside>

        <section className="detail-pane">
          {!activeRoot ? (
            <LibraryLanding onOpenFolder={() => void handlePickFolder()} />
          ) : (
            <>
              {activeRoot.selectedTrackIds.length > 0 && (
                <DetailActionBar
                  selectedCount={activeRoot.selectedTrackIds.length}
                  onShowInfo={() => setInfoModalOpen(true)}
                  onEdit={handleOpenEditModal}
                  onDelete={handleDeleteSelectedTracks}
                  onClearSelection={handleClearSelection}
                />
              )}

              {detailTracks.length > 0 ? (
                <AlbumOverview
                  rootLabel={detailLabel}
                  tracks={detailTracks}
                  selectedTrackIds={activeRoot.selectedTrackIds}
                  onSelectTrack={handleSelectTrack}
                  onPlayTrack={handlePlayVisibleTrack}
                  playingTrackId={playbackTrack?.id ?? null}
                  isAudioPlaying={isAudioPlaying}
                />
              ) : (
                <section className="selection-prompt">
                  <span className="detail-eyebrow">{activeRoot.label}</span>
                  <h2>Selecciona un album o una pista</h2>
                  <p>
                    Elige una carpeta del arbol para ver sus albumes, o usa Shift al pulsar
                    pistas para revisar una seleccion multiple.
                  </p>
                </section>
              )}
            </>
          )}
        </section>
      </section>
      <PreferencesModal
        open={preferencesOpen}
        theme={theme}
        onClose={() => setPreferencesOpen(false)}
        onToggleTheme={toggleTheme}
      />
      <MetadataEditModal
        open={editModalOpen}
        tracks={selectedTracks}
        value={activeRoot?.draft ?? emptyMetadata()}
        saving={saving}
        onChange={handleChangeDraft}
        onSave={handleSave}
        onClose={() => setEditModalOpen(false)}
      />
      <TrackInfoModal
        open={infoModalOpen}
        tracks={selectedTracks}
        onClose={() => setInfoModalOpen(false)}
      />
    </main>
  );
}



function computeCommonMetadata(tracks: Mp3Track[]): EditableMetadata {
  if (tracks.length === 0) {
    return emptyMetadata();
  }

  const first = tracks[0].metadata;
  const result: EditableMetadata = { ...first };

  for (let i = 1; i < tracks.length; i++) {
    const meta = tracks[i].metadata;
    if (meta.title !== result.title) result.title = "";
    if (meta.artist !== result.artist) result.artist = "";
    if (meta.album !== result.album) result.album = "";
    if (meta.year !== result.year) result.year = "";
    if (meta.genre !== result.genre) result.genre = "";
    if (meta.trackNumber !== result.trackNumber) result.trackNumber = "";
    if (meta.coverDataUrl !== result.coverDataUrl) result.coverDataUrl = null;
  }

  return result;
}

function getVariedFields(tracks: Mp3Track[]): {
  title: boolean;
  artist: boolean;
  album: boolean;
  year: boolean;
  genre: boolean;
  trackNumber: boolean;
  coverDataUrl: boolean;
} {
  if (tracks.length <= 1) {
    return {
      title: false,
      artist: false,
      album: false,
      year: false,
      genre: false,
      trackNumber: false,
      coverDataUrl: false
    };
  }

  const first = tracks[0].metadata;
  return {
    title: tracks.some((t) => t.metadata.title !== first.title),
    artist: tracks.some((t) => t.metadata.artist !== first.artist),
    album: tracks.some((t) => t.metadata.album !== first.album),
    year: tracks.some((t) => t.metadata.year !== first.year),
    genre: tracks.some((t) => t.metadata.genre !== first.genre),
    trackNumber: tracks.some((t) => t.metadata.trackNumber !== first.trackNumber),
    coverDataUrl: tracks.some((t) => t.metadata.coverDataUrl !== first.coverDataUrl)
  };
}



function inferDiscLabel(track: Mp3Track): string {
  const byPath = track.relativePath.match(/(?:^|\/)(?:cd|disc)[ _-]?(\d+)(?:\/|$)/i);
  if (byPath?.[1]) {
    return `Disco ${byPath[1]}`;
  }

  return "Disco 1";
}

function trackNumberOrder(track: Mp3Track): number {
  const match = track.metadata.trackNumber.match(/\d+/);
  return match ? Number(match[0]) : Number.POSITIVE_INFINITY;
}

function orderDetailPlaylist(tracks: Mp3Track[]): Mp3Track[] {
  return [...tracks].sort((left, right) => {
    const albumOrder = (left.metadata.album || left.relativePath.split("/")[0]).localeCompare(
      right.metadata.album || right.relativePath.split("/")[0],
      "es"
    );
    if (albumOrder !== 0) {
      return albumOrder;
    }

    const discOrder = inferDiscLabel(left).localeCompare(inferDiscLabel(right), "es", { numeric: true });
    if (discOrder !== 0) {
      return discOrder;
    }

    const trackOrder = trackNumberOrder(left) - trackNumberOrder(right);
    if (trackOrder !== 0) {
      return trackOrder;
    }

    return left.name.localeCompare(right.name, "es");
  });
}

async function readMetaSnapshot(vfs: BrowserVfs): Promise<MetaSnapshot> {
  const raw = await vfs.readTextFile(META_FILE_PATH);
  if (!raw) {
    return emptySnapshot();
  }

  try {
    const parsed = JSON.parse(raw) as MetaSnapshot;
    return parsed?.version === 1 && parsed?.tracks ? parsed : emptySnapshot();
  } catch {
    return emptySnapshot();
  }
}

async function writeMetaSnapshot(vfs: BrowserVfs, snapshot: MetaSnapshot): Promise<void> {
  await vfs.writeTextFile(META_FILE_PATH, JSON.stringify(snapshot, null, 2));
}

function collectFolderPaths(tracks: Mp3Track[]): string[] {
  const paths = new Set<string>();

  for (const track of tracks) {
    const folders = track.relativePath.split("/").slice(0, -1);
    let current = "";

    for (const folder of folders) {
      current = current ? `${current}/${folder}` : folder;
      paths.add(current);
    }
  }

  return [...paths];
}

function buildWizardRows(tracks: Mp3Track[], root: RootWorkspace | null): WizardTreeRow[] {
  type FolderNode = {
    folders: Map<string, FolderNode>;
    tracks: Mp3Track[];
  };

  const rootNode: FolderNode = { folders: new Map(), tracks: [] };

  for (const track of tracks) {
    const folders = track.relativePath.split("/").slice(0, -1);
    let node = rootNode;

    for (const folder of folders) {
      if (!node.folders.has(folder)) {
        node.folders.set(folder, { folders: new Map(), tracks: [] });
      }
      node = node.folders.get(folder)!;
    }

    node.tracks.push(track);
  }

  const expandedAlbums = new Set(root?.expandedAlbums ?? []);
  const rows: WizardTreeRow[] = [];

  function appendNode(node: FolderNode, parentPath: string, parentKey: string | null, depth: number): void {
    for (const [folder, child] of [...node.folders.entries()].sort(([left], [right]) => left.localeCompare(right, "es"))) {
      const folderPath = parentPath ? `${parentPath}/${folder}` : folder;
      const folderKey = `folder:${folderPath}`;
      const expanded = expandedAlbums.has(folderPath);

      rows.push({
        key: folderKey,
        kind: "album",
        album: folderPath,
        label: folder,
        expanded,
        parentKey,
        depth
      });

      if (expanded) {
        appendNode(child, folderPath, folderKey, depth + 1);
      }
    }

    for (const track of [...node.tracks].sort((left, right) => left.relativePath.localeCompare(right.relativePath, "es"))) {
      rows.push({
        key: `track:${track.id}`,
        kind: "track",
        album: parentPath,
        label: track.metadata.title || track.name,
        trackId: track.id,
        trackNumber: track.metadata.trackNumber,
        artist: track.metadata.artist,
        relativePath: track.relativePath,
        parentKey,
        depth
      });
    }
  }

  appendNode(rootNode, "", null, 0);

  return rows;
}
