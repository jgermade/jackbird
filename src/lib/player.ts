// The audio: one Audio element, owned here rather than by any view, so the
// faceplate, the album sheet and whatever comes next all drive the same
// player. It plays the queue in `playback`, from the root it belongs to, and
// writes back whether it plays, where it is and how long the track is.

import { $computed, $toRaw } from "jq79";
import { spectrumBands } from "../helpers/spectrum";
import type { PlaybackQueue } from "../types";
import { t } from "./i18n";
import { library } from "./library";
import { playback } from "./playback";

/** The current track of the queue, as the display shows it; null when nothing is queued. */
export type NowPlaying = {
  /** Root and track id: what a reload is keyed on. */
  key: string;
  rootId: string;
  trackId: string;
  relativePath: string;
  title: string;
  artist: string;
  /** 1-based position in the queue, and the queue's length. */
  position: number;
  total: number;
  sourceLabel: string;
};

export const nowPlaying = $computed((): NowPlaying | null => {
  const queue = playback.queue;
  if (!queue) {
    return null;
  }
  const root = library.roots.find((item) => item.id === queue.rootId);
  if (!root) {
    return null;
  }
  const byId = new Map(root.tracks.map((track) => [track.id, track]));
  const tracks = queue.trackIds.flatMap((id) => byId.get(id) ?? []);
  const track = tracks[playback.index];
  if (!track) {
    return null;
  }
  return {
    key: `${queue.rootId}:${track.id}`,
    rootId: queue.rootId,
    trackId: track.id,
    relativePath: track.relativePath,
    title: track.metadata.title || track.name,
    artist: track.metadata.artist,
    position: playback.index + 1,
    total: tracks.length,
    sourceLabel: queue.sourceLabel
  };
});

const audio: HTMLAudioElement | null = typeof Audio === "function" ? new Audio() : null;

// Bookkeeping, not state: which track the element holds, and its object URL.
let loadedKey: string | null = null;
let objectUrl: string | null = null;

// The spectrum: the element routed through an analyser on its way to the
// speakers, built on the first play (a context needs the person to have
// interacted with the page) and resumed on each one. Once routed, the
// element sounds only through the context, so a context that cannot be made
// leaves the element as it was.
let context: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let bins: Uint8Array<ArrayBuffer> | null = null;

function routeThroughAnalyser(element: HTMLAudioElement): void {
  if (!context) {
    if (typeof AudioContext !== "function") {
      return;
    }
    try {
      const made = new AudioContext();
      const node = made.createAnalyser();
      node.fftSize = 1024;
      node.smoothingTimeConstant = 0.8;
      made.createMediaElementSource(element).connect(node);
      node.connect(made.destination);
      context = made;
      analyser = node;
      bins = new Uint8Array(node.frequencyBinCount);
    } catch {
      return;
    }
  }
  if (context.state === "suspended") {
    void context.resume().catch(() => undefined);
  }
}

/**
 * What the music sounds like now, in `bands` levels from 0 to 1, low
 * frequencies first (see spectrumBands); `null` before the first play, or
 * where the browser has no Web Audio.
 */
export function readSpectrum(bands: number): number[] | null {
  if (!analyser || !bins) {
    return null;
  }
  analyser.getByteFrequencyData(bins);
  return spectrumBands(bins, bands);
}

function release(): void {
  if (objectUrl) {
    URL.revokeObjectURL(objectUrl);
    objectUrl = null;
  }
}

/** Loads and plays the current track, unless it is the one already loaded. */
async function load(current: NowPlaying | null): Promise<void> {
  const key = current?.key ?? null;
  if (key === loadedKey || !audio) {
    return;
  }
  loadedKey = key;
  audio.pause();
  audio.removeAttribute("src");
  release();
  playback.position = 0;
  playback.duration = 0;
  playback.error = null;

  if (!current) {
    playback.loading = false;
    playback.playing = false;
    return;
  }

  playback.loading = true;
  try {
    const root = $toRaw(library).roots.find((item) => item.id === current.rootId);
    if (!root) {
      throw new Error(t("playback.folderGone"));
    }
    const bytes = await root.vfs.read(current.relativePath);
    if (loadedKey !== key) {
      return;
    }
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    objectUrl = URL.createObjectURL(new Blob([copy.buffer], { type: "audio/mpeg" }));
    audio.src = objectUrl;
    await audio.play();
  } catch (error) {
    if (loadedKey === key) {
      playback.error = error instanceof Error ? error.message : t("playback.loadFailed");
      playback.playing = false;
    }
  } finally {
    if (loadedKey === key) {
      playback.loading = false;
    }
  }
}

if (audio) {
  audio.addEventListener("play", () => {
    routeThroughAnalyser(audio);
    playback.playing = true;
  });
  audio.addEventListener("pause", () => {
    playback.playing = false;
  });
  audio.addEventListener("ended", () => {
    playback.playing = false;
    next();
  });
  audio.addEventListener("timeupdate", () => {
    playback.position = audio.currentTime;
  });
  audio.addEventListener("durationchange", () => {
    playback.duration = Number.isFinite(audio.duration) ? audio.duration : 0;
  });
  nowPlaying.$on("value", (value: NowPlaying | null) => void load(value), { immediate: true });
}

/** Plays `queue` from its `index`-th track. */
export function playQueue(queue: PlaybackQueue, index: number): void {
  playback.queue = queue;
  playback.index = index;
}

/** Pauses or resumes the loaded track. */
export function togglePlay(): void {
  if (!audio?.src) {
    return;
  }
  if (audio.paused) {
    void audio.play().catch((error: unknown) => {
      playback.error = error instanceof Error ? error.message : t("playback.loadFailed");
    });
  } else {
    audio.pause();
  }
}

export function next(): void {
  const total = $toRaw(nowPlaying).value?.total ?? 0;
  playback.index = Math.max(0, Math.min(total - 1, playback.index + 1));
}

export function previous(): void {
  playback.index = Math.max(0, playback.index - 1);
}
