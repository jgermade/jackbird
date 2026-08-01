import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { AlbumOverview } from "../components/AlbumOverview";
import { FolderPicker } from "../components/FolderPicker";
import { LibraryLanding } from "../components/LibraryLanding";
import { MetadataEditor } from "../components/MetadataEditor";
import { RootTabs } from "../components/RootTabs";
import { ThemeToggle } from "../components/ThemeToggle";
import { TrackWizardList, type WizardTreeRow } from "../components/TrackWizardList";
import { readTrackMetadataFromBytes, writeTrackMetadataToBytes } from "../lib/id3";
import { loadRootSession, saveRootSession } from "../lib/rootSessionStore";
import { useTheme } from "../services/ThemeService";
import type { EditableMetadata, Mp3Track, TrackMetadata } from "../types";
import { BrowserVfs } from "../vfs/browserVfs";

type GroupingMode = "flat" | "wizard";

type MetaRecord = {
  checksum: string;
  metadata: TrackMetadata;
  updatedAt: string;
};

type MetaSnapshot = {
  version: 1;
  tracks: Record<string, MetaRecord>;
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

  const activeRoot = useMemo(
    () => roots.find((root) => root.id === activeRootId) ?? null,
    [roots, activeRootId]
  );

  const selectedTrack = useMemo(
    () => activeRoot?.tracks.find((track) => track.id === activeRoot.selectedTrackId) ?? null,
    [activeRoot]
  );

  const treeRows = useMemo(() => buildWizardRows(activeRoot?.tracks ?? [], activeRoot), [activeRoot]);

  const rowByKey = useMemo(
    () => new Map(treeRows.map((row) => [row.key, row])),
    [treeRows]
  );

  const detailScope = useMemo(() => {
    if (!activeRoot) {
      return { label: "", tracks: [] as Mp3Track[] };
    }

    if (activeRoot.selectedTrackIds.length > 0) {
      const selectedIds = new Set(activeRoot.selectedTrackIds);
      return {
        label: activeRoot.selectedTrackIds.length === 1 ? activeRoot.label : "Pistas seleccionadas",
        tracks: activeRoot.tracks.filter((track) => selectedIds.has(track.id))
      };
    }

    const row = activeRoot.activeRowKey ? rowByKey.get(activeRoot.activeRowKey) : undefined;
    if (row?.kind === "album") {
      return {
        label: row.label,
        tracks: activeRoot.tracks.filter((track) => (track.metadata.album.trim() || "Sin album") === row.album)
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

    return { label: activeRoot.label, tracks: [] as Mp3Track[] };
  }, [activeRoot, rowByKey]);

  const detailTracks = detailScope.tracks;
  const detailLabel = detailScope.label;

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

  async function hydrateRoot(
    vfs: BrowserVfs,
    options: {
      rootId?: string;
      rootLabel?: string;
      groupingMode?: GroupingMode;
      setActive?: boolean;
    } = {}
  ): Promise<void> {
    const mp3Files = await vfs.listFiles({ extensions: [".mp3"] });
    const nextTracks: Mp3Track[] = mp3Files.map((entry) => ({
      id: entry.relativePath,
      name: entry.name,
      relativePath: entry.relativePath,
      size: entry.size,
      vfsFileId: entry.id,
      checksum: "",
      metadata: emptyMetadata()
    }));

    const rootId = options.rootId ?? `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const rootLabel = options.rootLabel ?? (vfs.getRootName() || `Root ${roots.length + 1}`);
    const groupingMode = options.groupingMode ?? "wizard";
    const snapshot = await readMetaSnapshot(vfs);

    setRoots((currentRoots) => {
      const existingIndex = currentRoots.findIndex((root) => root.id === rootId);
      const nextRoot: RootWorkspace = {
        id: rootId,
        label: rootLabel,
        vfs,
        tracks: nextTracks,
        selectedTrackId: null,
        selectedTrackIds: [],
        selectionAnchorTrackId: null,
        draft: emptyMetadata(),
        loadingMetadata: true,
        loadedCount: 0,
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

    setInfoMessage(`Root ${rootLabel} abierta. Cargando metadatos 0/${nextTracks.length}...`);

    const pendingUpdates: Array<{ trackId: string; metadata: TrackMetadata; checksum: string }> = [];
    let loadedCount = 0;
    let snapshotDirty = false;

    function flush(): void {
      const updates = [...pendingUpdates];
      pendingUpdates.length = 0;

      setRoots((currentRoots) =>
        currentRoots.map((root) => {
          if (root.id !== rootId) {
            return root;
          }

          let nextDraft = root.draft;
          const nextTracksById = new Map(root.tracks.map((item) => [item.id, item]));

          for (const update of updates) {
            const currentTrack = nextTracksById.get(update.trackId);
            if (!currentTrack) {
              continue;
            }

            nextTracksById.set(update.trackId, {
              ...currentTrack,
              checksum: update.checksum,
              metadata: update.metadata
            });

            if (root.selectedTrackId === update.trackId && isEmptyMetadata(nextDraft)) {
              nextDraft = update.metadata;
            }
          }

          return {
            ...root,
            tracks: root.tracks.map((item) => nextTracksById.get(item.id) ?? item),
            draft: nextDraft,
            loadedCount,
            loadingMetadata: loadedCount < nextTracks.length,
            metaSnapshot: snapshot
          };
        })
      );

      setInfoMessage(`Root ${rootLabel}. Cargando metadatos ${loadedCount}/${nextTracks.length}...`);
    }

    // Files are read and their metadata parsed concurrently (bounded pool)
    // instead of one track at a time: while one file's bytes are still being
    // read from disk, other workers can already be hashing/parsing the files
    // that arrived first, overlapping I/O with CPU work.
    const READ_CONCURRENCY = 6;
    let cursor = 0;

    async function worker(): Promise<void> {
      while (true) {
        const trackIndex = cursor;
        cursor += 1;
        if (trackIndex >= nextTracks.length) {
          return;
        }

        const track = nextTracks[trackIndex];
        const sourceBytes = await vfs.readFile(track.vfsFileId);
        const checksum = await sha1Hex(sourceBytes);
        const stored = snapshot.tracks[track.relativePath];
        const metadata =
          stored && stored.checksum === checksum
            ? stored.metadata
            : await readTrackMetadataFromBytes(sourceBytes, track.name);

        if (!stored || stored.checksum !== checksum) {
          snapshot.tracks[track.relativePath] = {
            checksum,
            metadata,
            updatedAt: new Date().toISOString()
          };
          snapshotDirty = true;
        }

        pendingUpdates.push({ trackId: track.id, metadata, checksum });
        loadedCount += 1;

        if (loadedCount % 10 === 0 || loadedCount === nextTracks.length) {
          flush();
        }
      }
    }

    await Promise.all(
      Array.from({ length: Math.min(READ_CONCURRENCY, nextTracks.length) }, () => worker())
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
              loadedCount: nextTracks.length,
              metaSnapshot: snapshot
            }
          : root
      )
    );

    setInfoMessage(`Root ${rootLabel} lista. ${nextTracks.length} archivos MP3 preparados.`);
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

  function handleSelectTrack(trackId: string, extendRange = false): void {
    if (!activeRootId) {
      return;
    }

    setRoots((currentRoots) =>
      currentRoots.map((root) => {
        if (root.id !== activeRootId) {
          return root;
        }

        const track = root.tracks.find((item) => item.id === trackId);
        const visibleTrackIds = treeRows.flatMap((row) => (row.kind === "track" && row.trackId ? [row.trackId] : []));
        const anchorIndex = root.selectionAnchorTrackId ? visibleTrackIds.indexOf(root.selectionAnchorTrackId) : -1;
        const targetIndex = visibleTrackIds.indexOf(trackId);
        const selectedTrackIds =
          extendRange && anchorIndex !== -1 && targetIndex !== -1
            ? visibleTrackIds.slice(Math.min(anchorIndex, targetIndex), Math.max(anchorIndex, targetIndex) + 1)
            : [trackId];
        const singleSelection = selectedTrackIds.length === 1;

        return {
          ...root,
          selectedTrackId: singleSelection ? trackId : null,
          selectedTrackIds,
          selectionAnchorTrackId: extendRange && root.selectionAnchorTrackId ? root.selectionAnchorTrackId : trackId,
          activeRowKey: `track:${trackId}`,
          draft: singleSelection ? track?.metadata ?? emptyMetadata() : emptyMetadata()
        };
      })
    );

    setInfoMessage(null);
    setErrorMessage(null);
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

  async function handleLoadAudioBytes(track: Mp3Track): Promise<Uint8Array> {
    if (!activeRoot) {
      throw new Error("No hay ninguna carpeta activa.");
    }

    return activeRoot.vfs.readFile(track.vfsFileId);
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

  async function handleSave(): Promise<void> {
    if (!selectedTrack || !activeRoot) {
      return;
    }

    setSaving(true);
    setErrorMessage(null);
    setInfoMessage(null);

    try {
      const sourceBytes = await activeRoot.vfs.readFile(selectedTrack.vfsFileId);
      const nextBytes = await writeTrackMetadataToBytes(sourceBytes, activeRoot.draft);
      await activeRoot.vfs.writeFile(selectedTrack.vfsFileId, nextBytes);
      const checksum = await sha1Hex(nextBytes);

      const nextSnapshot: MetaSnapshot = {
        ...activeRoot.metaSnapshot,
        tracks: {
          ...activeRoot.metaSnapshot.tracks,
          [selectedTrack.relativePath]: {
            checksum,
            metadata: { ...activeRoot.draft },
            updatedAt: new Date().toISOString()
          }
        }
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
            tracks: root.tracks.map((item) =>
              item.id === selectedTrack.id
                ? {
                    ...item,
                    checksum,
                    metadata: { ...root.draft }
                  }
                : item
            )
          };
        })
      );

      setInfoMessage(`Metadatos guardados en ${selectedTrack.name}. Operaciones VFS en tab: ${writeCount}.`);
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
            <ThemeToggle theme={theme} onToggle={toggleTheme} />
          </div>
        </div>
      </header>

      <section className="app-body">
        <aside className="library-pane" onKeyDown={handleLibraryKeyDown} tabIndex={0}>
          <div className="library-head">
            <h2>Library</h2>
            <span>{activeRoot?.tracks.length ?? 0}</span>
          </div>

          {(errorMessage || infoMessage || restoring) && (
            <section className="panel-message">
              {restoring && <p className="message info">Restaurando tabs...</p>}
              {errorMessage && <p className="message error">{errorMessage}</p>}
              {infoMessage && <p className="message info">{infoMessage}</p>}
            </section>
          )}

          {activeRoot?.loadingMetadata ? (
            <section className="panel panel-list">
              <div className="panel-title-row">
                <h2>Library</h2>
                <span>
                  {activeRoot.loadedCount}/{activeRoot.tracks.length}
                </span>
              </div>
              <p className="loading-hint">
                Cargando metadatos antes de agrupar por album ({activeRoot.loadedCount}/{activeRoot.tracks.length})...
              </p>
            </section>
          ) : (
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
          )}
        </aside>

        <section className="detail-pane">
          {!activeRoot ? (
            <LibraryLanding onOpenFolder={() => void handlePickFolder()} />
          ) : selectedTrack ? (
            <MetadataEditor
              track={selectedTrack}
              value={activeRoot.draft}
              saving={saving}
              onChange={handleChangeDraft}
              onSave={handleSave}
              onLoadAudioBytes={handleLoadAudioBytes}
            />
          ) : detailTracks.length > 0 ? (
            <AlbumOverview
              rootLabel={detailLabel}
              tracks={detailTracks}
              onSelectTrack={handleSelectTrack}
              onLoadAudioBytes={handleLoadAudioBytes}
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
        </section>
      </section>
    </main>
  );
}

function isEmptyMetadata(value: EditableMetadata): boolean {
  return (
    !value.title &&
    !value.artist &&
    !value.album &&
    !value.year &&
    !value.genre &&
    !value.trackNumber &&
    !value.coverDataUrl
  );
}

function parseTrackNumber(value: string): number {
  const match = value.match(/\d+/);
  return match ? Number(match[0]) : Number.POSITIVE_INFINITY;
}

async function sha1Hex(bytes: Uint8Array): Promise<string> {
  const stable = new Uint8Array(bytes.byteLength);
  stable.set(bytes);
  const digest = await crypto.subtle.digest("SHA-1", stable.buffer);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function inferDiscLabel(track: Mp3Track): string {
  const byPath = track.relativePath.match(/(?:^|\/)(?:cd|disc)[ _-]?(\d+)(?:\/|$)/i);
  if (byPath?.[1]) {
    return `Disco ${byPath[1]}`;
  }

  return "Disco 1";
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

function buildWizardRows(tracks: Mp3Track[], root: RootWorkspace | null): WizardTreeRow[] {
  const albumMap = new Map<string, Map<string, Mp3Track[]>>();

  for (const track of tracks) {
    const album = track.metadata.album.trim() || "Sin album";
    const disc = inferDiscLabel(track);

    if (!albumMap.has(album)) {
      albumMap.set(album, new Map<string, Mp3Track[]>());
    }

    const discMap = albumMap.get(album)!;
    if (!discMap.has(disc)) {
      discMap.set(disc, []);
    }

    discMap.get(disc)!.push(track);
  }

  const expandedAlbums = new Set(root?.expandedAlbums ?? []);
  const expandedDiscs = new Set(root?.expandedDiscs ?? []);
  const rows: WizardTreeRow[] = [];

  for (const [album, discsMap] of [...albumMap.entries()].sort(([left], [right]) => left.localeCompare(right, "es"))) {
    const albumKey = `album:${album}`;
    const albumExpanded = expandedAlbums.has(album);
    rows.push({
      key: albumKey,
      kind: "album",
      album,
      label: album,
      expanded: albumExpanded,
      parentKey: null,
      depth: 0
    });

    if (!albumExpanded) {
      continue;
    }

    for (const [disc, discTracks] of [...discsMap.entries()].sort(([left], [right]) => left.localeCompare(right, "es"))) {
      const discToken = `${album}::${disc}`;
      const discKey = `disc:${discToken}`;
      const discExpanded = expandedDiscs.has(discToken);

      rows.push({
        key: discKey,
        kind: "disc",
        album,
        disc,
        label: disc,
        expanded: discExpanded,
        parentKey: albumKey,
        depth: 1
      });

      if (!discExpanded) {
        continue;
      }

      for (const track of [...discTracks].sort((left, right) => {
        const leftTrackNumber = parseTrackNumber(left.metadata.trackNumber);
        const rightTrackNumber = parseTrackNumber(right.metadata.trackNumber);

        if (leftTrackNumber !== rightTrackNumber) {
          return leftTrackNumber - rightTrackNumber;
        }

        return left.name.localeCompare(right.name, "es");
      })) {
        rows.push({
          key: `track:${track.id}`,
          kind: "track",
          album,
          disc,
          label: track.metadata.title || track.name,
          trackId: track.id,
          trackNumber: track.metadata.trackNumber,
          artist: track.metadata.artist,
          relativePath: track.relativePath,
          parentKey: discKey,
          depth: 2
        });
      }
    }
  }

  return rows;
}
