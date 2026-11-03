import { useEffect, useMemo } from "react";
import { MetadataEditModal } from "../components/MetadataEditModal";
import { PreferencesModal } from "../components/PreferencesModal";
import { TrackInfoModal } from "../components/TrackInfoModal";
import Faceplate from "./faceplate.html";
import Workspace from "./workspace.html";
import { Jq79Island } from "./Jq79Island";
import { emptyMetadata, getVariedFields } from "../helpers/metadata";
import { calculateDualChecksums, writeTrackMetadataToBytes } from "../lib/id3";
import { languageName, useT } from "../lib/i18n";
import { library } from "../lib/library";
import { writeMetaSnapshot } from "../lib/meta";
import { LANGUAGES, preferences, setLanguage, toggleTheme } from "../lib/preferences";
import { useStoreValue } from "../lib/react-store";
import { loadRootSession, saveRootSession } from "../lib/rootSessionStore";
import { hydrateRoot } from "../lib/roots";
import { ui } from "../lib/ui";
import type { EditableMetadata, MetaSnapshot, TrackMetadata } from "../types";
import { FSAAdapter } from "@cloudauthn/vfs-sync";

export function Mp3ManagerView(): JSX.Element {
  // What is left of the React view: the session restore and save, the
  // background verifier, and the three dialogs (step 6). The faceplate and
  // the workspace are jq79 views mounted through Jq79Island. State lives in
  // the lib/ stores; React reads it through useStoreValue.
  const t = useT();
  const [theme] = useStoreValue(preferences, "theme");
  const [language] = useStoreValue(preferences, "language");
  const [roots, setRoots] = useStoreValue(library, "roots");
  const [activeRootId, setActiveRootId] = useStoreValue(library, "activeRootId");
  const [saving, setSaving] = useStoreValue(library, "saving");
  const [restoring, setRestoring] = useStoreValue(library, "restoring");
  const [, setErrorMessage] = useStoreValue(library, "errorMessage");
  const [, setInfoMessage] = useStoreValue(library, "infoMessage");
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

      <Jq79Island component={Workspace} className="workspace-island" />
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
