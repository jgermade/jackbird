import { useMemo, useState } from "react";
import { FolderPicker } from "../components/FolderPicker";
import { MetadataEditor } from "../components/MetadataEditor";
import { TrackTable } from "../components/TrackTable";
import { readTrackMetadataFromBytes, writeTrackMetadataToBytes } from "../lib/id3";
import type { EditableMetadata, Mp3Track, TrackMetadata } from "../types";
import { BrowserVfs } from "../vfs/browserVfs";

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

export function Mp3ManagerView(): JSX.Element {
  const vfs = useMemo(() => new BrowserVfs(), []);
  const [tracks, setTracks] = useState<Mp3Track[]>([]);
  const [selectedTrackId, setSelectedTrackId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [infoMessage, setInfoMessage] = useState<string | null>(null);
  const [draft, setDraft] = useState<EditableMetadata>(emptyMetadata());

  const selectedTrack = useMemo(
    () => tracks.find((track) => track.id === selectedTrackId) ?? null,
    [tracks, selectedTrackId]
  );

  async function handlePickFolder(): Promise<void> {
    setLoading(true);
    setErrorMessage(null);
    setInfoMessage(null);

    try {
      await vfs.mount();
      const mp3Files = await vfs.listFiles({ extensions: [".mp3"] });
      const nextTracks: Mp3Track[] = [];

      for (const [index, entry] of mp3Files.entries()) {
        const bytes = await vfs.readFile(entry.id);
        const metadata = await readTrackMetadataFromBytes(bytes, entry.name);

        nextTracks.push({
          id: `${entry.relativePath}-${index}`,
          name: entry.name,
          relativePath: entry.relativePath,
          size: entry.size,
          vfsFileId: entry.id,
          metadata
        });
      }

      setTracks(nextTracks);
      setSelectedTrackId(nextTracks[0]?.id ?? null);
      setDraft(nextTracks[0]?.metadata ?? emptyMetadata());
      setInfoMessage(`Se detectaron ${nextTracks.length} archivos MP3.`);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "No se pudo escanear la carpeta seleccionada.");
    } finally {
      setLoading(false);
    }
  }

  function handleSelectTrack(id: string): void {
    setSelectedTrackId(id);
    const track = tracks.find((item) => item.id === id);
    setDraft(track?.metadata ?? emptyMetadata());
    setInfoMessage(null);
    setErrorMessage(null);
  }

  async function handleSave(): Promise<void> {
    if (!selectedTrack) {
      return;
    }

    setSaving(true);
    setErrorMessage(null);
    setInfoMessage(null);

    try {
      const sourceBytes = await vfs.readFile(selectedTrack.vfsFileId);
      const nextBytes = await writeTrackMetadataToBytes(sourceBytes, draft);
      await vfs.writeFile(selectedTrack.vfsFileId, nextBytes);
      const writeCount = vfs.getWriteOperations().length;

      setTracks((currentTracks) =>
        currentTracks.map((item) =>
          item.id === selectedTrack.id
            ? {
                ...item,
                metadata: { ...draft }
              }
            : item
        )
      );

  setInfoMessage(`Metadatos guardados en ${selectedTrack.name}. Operaciones VFS: ${writeCount}.`);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "No se pudieron guardar los cambios.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="layout">
      <FolderPicker onPickFolder={handlePickFolder} disabled={loading} loading={loading} />

      {(errorMessage || infoMessage) && (
        <section className="panel panel-message">
          {errorMessage && <p className="message error">{errorMessage}</p>}
          {infoMessage && <p className="message info">{infoMessage}</p>}
        </section>
      )}

      <section className="workspace-grid">
        <TrackTable tracks={tracks} selectedTrackId={selectedTrackId} onSelectTrack={handleSelectTrack} />
        <MetadataEditor
          track={selectedTrack}
          value={draft}
          saving={saving}
          onChange={setDraft}
          onSave={handleSave}
        />
      </section>
    </main>
  );
}
