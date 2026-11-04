// The audio: one Audio element, owned here rather than by any view, so the
// faceplate, the album sheet and whatever comes next all drive the same
// player. It plays the queue in `playback`, from the root it belongs to, and
// writes back whether it plays, where it is and how long the track is.

import { $computed, $toRaw } from "jq79";
import { parsePlaybackState } from "../helpers/session";
import { spectrumBands } from "../helpers/spectrum";
import type { PlaybackQueue } from "../types";
import { t } from "./i18n";
import { library } from "./library";
import { playback } from "./playback";
import { SESSION_KEYS, readSession, writeSession } from "./storage";

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

// After a reload: the track to come back to, where in it, and whether it was
// playing (see restorePlayback). Taken by the load of that track.
let resumeAt: { key: string; position: number; play: boolean } | null = null;
// When the first interaction after a blocked restart played the music: the
// ▶ that interaction may have been must not pause it again at once.
let resumedAt = 0;

/**
 * Plays on the first click or key anywhere: what is left when the browser
 * does not let a page start sound by itself after a reload.
 */
function resumeOnFirstInteraction(element: HTMLAudioElement): void {
  const events = ["pointerdown", "keydown"] as const;
  const resume = () => {
    events.forEach((type) => document.removeEventListener(type, resume, true));
    if (element.src && element.paused) {
      resumedAt = Date.now();
      void element.play().catch(() => undefined);
    }
  };
  events.forEach((type) => document.addEventListener(type, resume, true));
}

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
    const resume = resumeAt?.key === key ? resumeAt : null;
    resumeAt = null;
    if (resume) {
      // Back after a reload: at the same second, playing if it was.
      audio.currentTime = resume.position;
      playback.position = resume.position;
      if (resume.play) {
        try {
          await audio.play();
        } catch (error) {
          if (!(error instanceof DOMException && error.name === "NotAllowedError")) throw error;
          resumeOnFirstInteraction(audio);
        }
      }
      return;
    }
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
  if (Date.now() - resumedAt < 1000) {
    // This press already resumed the music (resumeOnFirstInteraction).
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

/** The music as it is now, for this tab to come back to after a reload. */
function savePlayback(): void {
  const { queue, index, playing } = $toRaw(playback);
  if (!queue) {
    writeSession(SESSION_KEYS.playback, "");
    return;
  }
  // A track still coming back after a reload is where it is coming back to.
  const position = resumeAt ? resumeAt.position : audio && audio.src ? audio.currentTime : $toRaw(playback).position;
  writeSession(SESSION_KEYS.playback, JSON.stringify({ queue, index, position, playing }));
}

/**
 * Comes back to the music saved before a reload, once the roots have
 * reopened: the same queue and track, at the same second, playing again if it
 * was (see load). Nothing when its root did not reopen.
 */
export function restorePlayback(): void {
  const saved = parsePlaybackState(readSession(SESSION_KEYS.playback));
  if (!saved || !$toRaw(library).roots.some((root) => root.id === saved.queue.rootId)) {
    return;
  }
  resumeAt = { key: `${saved.queue.rootId}:${saved.queue.trackIds[saved.index]}`, position: saved.position, play: saved.playing };
  playQueue(saved.queue, saved.index);
}

/**
 * Keeps the music saved for this tab: when the queue, the track or the state
 * changes, every second while it plays, and when the page goes away. Start it
 * after restorePlayback, or it would save over what is to be restored.
 */
export function keepPlaybackSaved(): void {
  let last = 0;
  playback.$effect(() => {
    // Read, so the effect wakes on each.
    void playback.queue;
    void playback.index;
    void playback.playing;
    savePlayback();
  });
  audio?.addEventListener("timeupdate", () => {
    if (Date.now() - last > 1000) {
      last = Date.now();
      savePlayback();
    }
  });
  window.addEventListener("pagehide", savePlayback);
}
