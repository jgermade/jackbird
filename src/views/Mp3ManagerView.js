import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useMemo, useState } from "react";
import { FolderPicker } from "../components/FolderPicker";
import { MetadataEditor } from "../components/MetadataEditor";
import { TrackTable } from "../components/TrackTable";
import { readTrackMetadataFromBytes, writeTrackMetadataToBytes } from "../lib/id3";
import { BrowserVfs } from "../vfs/browserVfs";
function emptyMetadata() {
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
export function Mp3ManagerView() {
    const vfs = useMemo(() => new BrowserVfs(), []);
    const [tracks, setTracks] = useState([]);
    const [selectedTrackId, setSelectedTrackId] = useState(null);
    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);
    const [errorMessage, setErrorMessage] = useState(null);
    const [infoMessage, setInfoMessage] = useState(null);
    const [draft, setDraft] = useState(emptyMetadata());
    const selectedTrack = useMemo(() => tracks.find((track) => track.id === selectedTrackId) ?? null, [tracks, selectedTrackId]);
    async function handlePickFolder() {
        setLoading(true);
        setErrorMessage(null);
        setInfoMessage(null);
        try {
            await vfs.mount();
            const mp3Files = await vfs.listFiles({ extensions: [".mp3"] });
            const nextTracks = [];
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
        }
        catch (error) {
            setErrorMessage(error instanceof Error ? error.message : "No se pudo escanear la carpeta seleccionada.");
        }
        finally {
            setLoading(false);
        }
    }
    function handleSelectTrack(id) {
        setSelectedTrackId(id);
        const track = tracks.find((item) => item.id === id);
        setDraft(track?.metadata ?? emptyMetadata());
        setInfoMessage(null);
        setErrorMessage(null);
    }
    async function handleSave() {
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
            setTracks((currentTracks) => currentTracks.map((item) => item.id === selectedTrack.id
                ? {
                    ...item,
                    metadata: { ...draft }
                }
                : item));
            setInfoMessage(`Metadatos guardados en ${selectedTrack.name}. Operaciones VFS: ${writeCount}.`);
        }
        catch (error) {
            setErrorMessage(error instanceof Error ? error.message : "No se pudieron guardar los cambios.");
        }
        finally {
            setSaving(false);
        }
    }
    return (_jsxs("main", { className: "layout", children: [_jsx(FolderPicker, { onPickFolder: handlePickFolder, disabled: loading, loading: loading }), (errorMessage || infoMessage) && (_jsxs("section", { className: "panel panel-message", children: [errorMessage && _jsx("p", { className: "message error", children: errorMessage }), infoMessage && _jsx("p", { className: "message info", children: infoMessage })] })), _jsxs("section", { className: "workspace-grid", children: [_jsx(TrackTable, { tracks: tracks, selectedTrackId: selectedTrackId, onSelectTrack: handleSelectTrack }), _jsx(MetadataEditor, { track: selectedTrack, value: draft, saving: saving, onChange: setDraft, onSave: handleSave })] })] }));
}
