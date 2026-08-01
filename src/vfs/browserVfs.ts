import type { VfsAdapter, VfsFile, VfsListOptions, VfsWriteOperation } from "./types";

type FileEntry = {
  file: VfsFile;
  handle: FileSystemFileHandle;
};

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

export class BrowserVfs implements VfsAdapter {
  private root: FileSystemDirectoryHandle | null = null;
  private entries = new Map<string, FileEntry>();
  private writes: VfsWriteOperation[] = [];

  async mount(): Promise<void> {
    if (!window.showDirectoryPicker) {
      throw new Error("Tu navegador no soporta File System Access API.");
    }

    this.root = await window.showDirectoryPicker({ mode: "readwrite" });
    this.entries.clear();
  }

  async listFiles(options?: VfsListOptions): Promise<VfsFile[]> {
    if (!this.root) {
      throw new Error("No hay ningun volumen montado en VFS.");
    }

    const files: VfsFile[] = [];
    const allowedExtensions = (options?.extensions ?? []).map((value) => value.toLowerCase());

    for await (const entry of this.walk(this.root, "")) {
      if (allowedExtensions.length > 0) {
        const lowerName = entry.file.name.toLowerCase();
        const accepted = allowedExtensions.some((ext) => lowerName.endsWith(ext));
        if (!accepted) {
          continue;
        }
      }

      this.entries.set(entry.file.id, entry);
      files.push(entry.file);
    }

    return files;
  }

  async readFile(fileId: string): Promise<Uint8Array> {
    const entry = this.entries.get(fileId);
    if (!entry) {
      throw new Error("Archivo no encontrado en VFS.");
    }

    const file = await entry.handle.getFile();
    return new Uint8Array(await file.arrayBuffer());
  }

  async writeFile(fileId: string, bytes: Uint8Array): Promise<void> {
    const entry = this.entries.get(fileId);
    if (!entry) {
      throw new Error("Archivo no encontrado en VFS.");
    }

    const writable = await entry.handle.createWritable();
    await writable.write(toArrayBuffer(bytes));
    await writable.close();

    this.writes.push({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      fileId,
      relativePath: entry.file.relativePath,
      timestamp: new Date().toISOString(),
      sizeBytes: bytes.byteLength
    });
  }

  getWriteOperations(): VfsWriteOperation[] {
    return [...this.writes];
  }

  private async *walk(
    directory: FileSystemDirectoryHandle,
    basePath: string
  ): AsyncGenerator<FileEntry, void, undefined> {
    for await (const child of directory.values()) {
      const relativePath = basePath ? `${basePath}/${child.name}` : child.name;

      if (child.kind === "directory") {
        yield* this.walk(child as FileSystemDirectoryHandle, relativePath);
        continue;
      }

      const fileHandle = child as FileSystemFileHandle;
      const file = await fileHandle.getFile();
      const id = `${relativePath}#${file.lastModified}#${file.size}`;

      yield {
        file: {
          id,
          name: file.name,
          relativePath,
          size: file.size
        },
        handle: fileHandle
      };
    }
  }
}
