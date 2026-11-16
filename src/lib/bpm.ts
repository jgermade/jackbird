// Working out tracks' BPM for the edit dialog (RECORD/2026-11-03.deck-design-system.WIP.md, step 3):
// each file decoded in the browser, mono at 11 025 Hz, and its tempo told by helpers/bpm.ts. One
// track's goes into the form's field; several tracks' are kept, one each, until Save writes them
// (lib/editor.ts's `saveEdits`). One at a time, and it can be cancelled.

import { $reactive } from "jq79";
import { detectBpm } from "../helpers/bpm";
import type { RootSource, Track } from "../types";

/** The rate the audio is decoded at: enough for a beat, a fraction of the memory. */
const RATE = 11_025;

/** The work under way: how far, and on which file; `total` is 0 when there is none. */
export const bpmJob = $reactive({ at: 0, total: 0, name: "" });
let cancelled = false;

/** The file's bytes: through the URL it plays from (every source has one), else its folder. */
async function bytesOf(source: RootSource, path: string): Promise<ArrayBuffer> {
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

/** The file decoded, its channels mixed into one, at `RATE`. */
async function decode(bytes: ArrayBuffer): Promise<Float32Array> {
  const context = new OfflineAudioContext(1, 1, RATE);
  const buffer = await context.decodeAudioData(bytes);
  if (buffer.numberOfChannels === 1) return buffer.getChannelData(0);
  const mono = new Float32Array(buffer.length);
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < data.length; i += 1) mono[i] += data[i] / buffer.numberOfChannels;
  }
  return mono;
}

/** A track's BPM, a whole number as text; "" when no beat could be told. Throws when the file cannot be read or decoded. */
export async function trackBpm(source: RootSource, track: Track): Promise<string> {
  const bpm = detectBpm(await decode(await bytesOf(source, track.relativePath)), RATE);
  return bpm === null ? "" : String(Math.round(bpm));
}

/**
 * Works out each track's BPM in turn, telling `found` of each (its value, or "" when none could be
 * told or the file could not be read). Resolves to how many failed; stops early when cancelled.
 */
export async function computeBpms(source: RootSource, tracks: readonly Track[], found: (track: Track, bpm: string) => void): Promise<number> {
  cancelled = false;
  let failed = 0;
  try {
    for (const [index, track] of tracks.entries()) {
      if (cancelled) break;
      bpmJob.at = index + 1;
      bpmJob.total = tracks.length;
      bpmJob.name = track.name;
      try {
        const bpm = await trackBpm(source, track);
        if (!cancelled) found(track, bpm);
        if (!bpm) failed += 1;
      } catch (error) {
        failed += 1;
        console.error(`jackbird: could not work out the BPM of ${track.relativePath}`, error);
      }
    }
  } finally {
    bpmJob.at = 0;
    bpmJob.total = 0;
    bpmJob.name = "";
  }
  return failed;
}

/** Stops the work under way after the file it is on. */
export function cancelBpms(): void {
  cancelled = true;
}
