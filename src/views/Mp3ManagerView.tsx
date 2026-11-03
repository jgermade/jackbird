import { useEffect, useMemo, type KeyboardEvent } from "react";
import { AlbumOverview } from "../components/AlbumOverview";
import { DetailActionBar } from "../components/DetailActionBar";
import { LibraryLanding } from "../components/LibraryLanding";
import { MetadataEditModal } from "../components/MetadataEditModal";
import { PreferencesModal } from "../components/PreferencesModal";
import { TrackInfoModal } from "../components/TrackInfoModal";
import { TrackWizardList } from "../components/TrackWizardList";
import Faceplate from "./faceplate.html";
import { Jq79Island } from "./Jq79Island";
import { computeCommonMetadata, emptyMetadata, getVariedFields } from "../helpers/metadata";
import { collectFolderPaths, orderDetailPlaylist } from "../helpers/tracks";
import { buildWizardRows } from "../helpers/tree";
import { calculateDualChecksums, writeTrackMetadataToBytes } from "../lib/id3";
import { languageName, useT } from "../lib/i18n";
import { library } from "../lib/library";
import { writeMetaSnapshot } from "../lib/meta";
import { playback } from "../lib/playback";
import { playQueue, togglePlay } from "../lib/player";
import { LANGUAGES, preferences, setLanguage, toggleTheme } from "../lib/preferences";
import { useStoreValue } from "../lib/react-store";
import { loadRootSession, saveRootSession } from "../lib/rootSessionStore";
import { hydrateRoot, openFolder } from "../lib/roots";
import { ui } from "../lib/ui";
import type { EditableMetadata, MetaSnapshot, Mp3Track, TrackMetadata } from "../types";
import { FSAAdapter } from "@cloudauthn/vfs-sync";



export function Mp3ManagerView(): JSX.Element {
  // State lives in the lib/ stores; React reads it through useStoreValue
  // until this view is rewritten as jq79 views (see "Layers" in AGENTS.md).
  const t = useT();
  const [theme] = useStoreValue(preferences, "theme");
  const [language] = useStoreValue(preferences, "language");
  const [roots, setRoots] = useStoreValue(library, "roots");
  const [activeRootId, setActiveRootId] = useStoreValue(library, "activeRootId");
  const [saving, setSaving] = useStoreValue(library, "saving");
  const [restoring, setRestoring] = useStoreValue(library, "restoring");
  const [errorMessage, setErrorMessage] = useStoreValue(library, "errorMessage");
  const [infoMessage, setInfoMessage] = useStoreValue(library, "infoMessage");
  const [playbackQueue] = useStoreValue(playback, "queue");
  const [playbackIndex] = useStoreValue(playback, "index");
  const [isAudioPlaying] = useStoreValue(playback, "playing");
  const [preferencesOpen, setPreferencesOpen] = useStoreValue(ui, "preferencesOpen");
  const [editModalOpen, setEditModalOpen] = useStoreValue(ui, "editModalOpen");
  const [infoModalOpen, setInfoModalOpen] = useStoreValue(ui, "infoModalOpen");

  useEffect(() => {
    document.title = t("app.name");
  }, [t]);

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

  const treeRows = useMemo(() => buildWizardRows(activeRoot?.tracks ?? [], activeRoot?.expandedAlbums ?? []), [activeRoot]);

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

          const vfs = FSAAdapter.fromHandle(persistedRoot.handle);
          const hasPermission = await vfs.ensurePermission();

          if (!hasPermission) {
            continue;
          }

          await hydrateRoot(vfs, {
            rootHandle: persistedRoot.handle,
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
      .map((root) => ({
        id: root.id,
        label: root.label,
        handle: root.rootHandle,
        groupingMode: root.groupingMode
      }));

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
          const sourceBytes = await activeRoot.vfs.read(track.relativePath);
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
    const message = t.n("message.removeConfirm", count);

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

    setInfoMessage(t.n("message.removed", count));
  }

  function handlePlayVisibleTrack(trackId: string): void {
    if (!activeRoot || detailTracks.length === 0) {
      return;
    }

    if (playbackTrack?.id === trackId) {
      togglePlay();
      return;
    }

    const trackIds = orderDetailPlaylist(detailTracks).map((track) => track.id);
    const index = trackIds.indexOf(trackId);
    if (index === -1) {
      return;
    }

    playQueue({ rootId: activeRoot.id, trackIds, sourceLabel: detailLabel }, index);
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
      t("message.consolidatePending")
    );
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

        const sourceBytes = await activeRoot.vfs.read(track.relativePath);
        const nextBytes = await writeTrackMetadataToBytes(sourceBytes, nextMeta);
        await activeRoot.vfs.write(track.relativePath, nextBytes);
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

      const trackLabel = selectedTracks.length === 1 ? selectedTracks[0].name : t.n("tracks.count", selectedTracks.length);
      setInfoMessage(t("message.saved", { target: trackLabel }));
      setEditModalOpen(false);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : t("message.saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="app-shell">
      <Jq79Island component={Faceplate} className="faceplate-island" />

      <section className="app-body">
        <aside className="library-pane" onKeyDown={handleLibraryKeyDown} tabIndex={0}>
          <div className="library-head">
            <div className="library-head-title">
              <h2>{t("library.title")}</h2>
              <span className="library-head-count">{activeRoot?.tracks.length ?? 0}</span>
            </div>
            <div className="library-head-actions">
              <button
                type="button"
                className="library-head-btn"
                onClick={handleExpandAllFolders}
                disabled={!activeRoot || activeRoot.tracks.length === 0}
                title={t("library.expandAll")}
                aria-label={t("library.expandAll")}
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
                title={t("library.collapseAll")}
                aria-label={t("library.collapseAll")}
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
              {restoring && <p className="message info">{t("library.restoring")}</p>}
              {errorMessage && <p className="message error">{errorMessage}</p>}
              {infoMessage && <p className="message info">{infoMessage}</p>}
            </section>
          )}

          {activeRoot?.loadingMetadata && (
            <p className="library-loading-status">
              {t("library.loadingMetadata", { loaded: activeRoot.loadedCount, total: activeRoot.tracks.length })}
            </p>
          )}

          <TrackWizardList
            t={t}
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
            <LibraryLanding t={t} onOpenFolder={() => void openFolder()} />
          ) : (
            <>
              {activeRoot.selectedTrackIds.length > 0 && (
                <DetailActionBar
                  t={t}
                  selectedCount={activeRoot.selectedTrackIds.length}
                  onShowInfo={() => setInfoModalOpen(true)}
                  onEdit={handleOpenEditModal}
                  onDelete={handleDeleteSelectedTracks}
                  onClearSelection={handleClearSelection}
                />
              )}

              {detailTracks.length > 0 ? (
                <AlbumOverview
                  t={t}
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
                  <h2>{t("detail.promptTitle")}</h2>
                  <p>{t("detail.promptBody")}</p>
                </section>
              )}
            </>
          )}
        </section>
      </section>
      <PreferencesModal
        t={t}
        open={preferencesOpen}
        theme={theme}
        language={language}
        languages={LANGUAGES.map((value) => ({ value, label: languageName(value) }))}
        onChangeLanguage={setLanguage}
        onClose={() => setPreferencesOpen(false)}
        onToggleTheme={toggleTheme}
      />
      <MetadataEditModal
        t={t}
        open={editModalOpen}
        tracks={selectedTracks}
        value={activeRoot?.draft ?? emptyMetadata()}
        saving={saving}
        onChange={handleChangeDraft}
        onSave={handleSave}
        onClose={() => setEditModalOpen(false)}
      />
      <TrackInfoModal
        t={t}
        open={infoModalOpen}
        tracks={selectedTracks}
        onClose={() => setInfoModalOpen(false)}
      />
    </main>
  );
}
