// A file's bytes, from any source: through the URL it plays from (every source has one), else its
// folder. Read whole: for one file at a time (a tempo worked out, lib/bpm.ts; a song copied to
// another tab, lib/copying.ts).

import type { RootSource } from "../types";

export async function fileBytes(source: RootSource, path: string): Promise<ArrayBuffer> {
  const media = await source.openMedia(path);
  try {
    const response = await fetch(media.url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.arrayBuffer();
  } catch (error) {
    const read = await source.vfs.read(path).catch(() => null);
    if (!read) throw error;
    return read.slice().buffer;
  } finally {
    media.release();
  }
}
