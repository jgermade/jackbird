async function walkDirectory(directoryHandle, basePath, collector) {
    for await (const [name, entry] of directoryHandle.entries()) {
        const nextPath = basePath ? `${basePath}/${name}` : name;
        if (entry.kind === "directory") {
            await walkDirectory(entry, nextPath, collector);
            continue;
        }
        if (entry.kind === "file" && name.toLowerCase().endsWith(".mp3")) {
            collector.push({
                fileHandle: entry,
                relativePath: nextPath
            });
        }
    }
}
export async function pickMusicFolder() {
    if (!window.showDirectoryPicker) {
        throw new Error("Tu navegador no soporta File System Access API.");
    }
    return window.showDirectoryPicker({ mode: "readwrite" });
}
export async function collectMp3Files(directoryHandle) {
    const files = [];
    await walkDirectory(directoryHandle, "", files);
    return files;
}
