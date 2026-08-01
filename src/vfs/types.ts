export type VfsFile = {
  id: string;
  name: string;
  relativePath: string;
  size: number;
};

export type VfsWriteOperation = {
  id: string;
  fileId: string;
  relativePath: string;
  timestamp: string;
  sizeBytes: number;
};

export type VfsListOptions = {
  extensions?: string[];
};

export interface VfsAdapter {
  mount(): Promise<void>;
  listFiles(options?: VfsListOptions): Promise<VfsFile[]>;
  readFile(fileId: string): Promise<Uint8Array>;
  writeFile(fileId: string, bytes: Uint8Array): Promise<void>;
  getWriteOperations(): VfsWriteOperation[];
}
