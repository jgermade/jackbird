// The audio: one Audio element, owned here rather than by any view, so the
// faceplate, the album sheet and whatever comes next all drive the same
// player. It plays the queue in `playback`, each track from the root it
// belongs to (a queue spans the open roots), and writes back whether it
// plays, where it is and how long the track is. It plays the file itself
// (the root's source: lib/sources/), not a copy of its bytes, and opens it again when it is
// rewritten (see refresh). The queue's actions (play next, add, move,
// remove…) are here too; their list logic is helpers/queue.ts.

import { $computed, $toRaw } from "jq79";
import {
  addTo,
  clearUpcoming as clearAfterCurrent,
  dropItems,
  moveTo,
  playNextIn,
  removeAt,
  restoreQueue,
  type QueuePosition
} from "../helpers/queue";
import { parsePlaybackState } from "../helpers/session";
import { spectrumBands } from "../helpers/spectrum";
import type { MediaHandle, PlaybackQueue, QueueItem } from "../types";
import { t } from "./i18n";
import { library } from "./library";
import { Opaque } from "./opaque";
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
  /** The file's date as the library knows it: a save changes it. */
  lastModified?: number;
};

export const nowPlaying = $computed((): NowPlaying | null => {
  const queue = playback.queue;
  const item = queue?.items[playback.index];
  if (!queue || !item) {
    return null;
  }
  const track = library.roots.find((root) => root.id === item.rootId)?.tracks.find((one) => one.id === item.trackId);
  if (!track) {
    return null;
  }
  return {
    key: keyOf(item),
    rootId: item.rootId,
    trackId: track.id,
    relativePath: track.relativePath,
    title: track.metadata.title || track.name,
    artist: track.metadata.artist,
    position: playback.index + 1,
    total: queue.items.length,
    sourceLabel: queue.sourceLabel,
    lastModified: track.lastModified
  };
});

/**
 * Whether a failed `play()` was only interrupted (a pause, or another track,
 * before it started): not an error to show.
 */
function interrupted(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

/** What a track of the queue is keyed on: its root and its id. */
function keyOf(item: QueueItem): string {
  return `${item.rootId}:${item.trackId}`;
}

/** One track of the queue, as its dialog lists it. */
export type QueueEntry = {
  index: number;
  title: string;
  artist: string;
  /** The open root it is in. */
  rootLabel: string;
  /** Its cover, as a data URL; null without one. */
  cover: string | null;
  state: "played" | "current" | "upcoming";
  /** No longer in the library (removed from it since it was queued). */
  missing: boolean;
};

/** The queue's heading: where it comes from (or "Queue"). */
export function queueTitle(): string {
  return playback.queue?.sourceLabel || t("queue.title");
}

/** The line above the queue's heading: "Queue · 3 of 12" (or "Queue"). */
export function queueEyebrow(): string {
  const queue = playback.queue;
  return queue && queue.items.length > 0 ? t("queue.eyebrow", { position: playback.index + 1, total: queue.items.length }) : t("queue.title");
}

/** The queue's tracks for its dialog, boxed (see Opaque): read `.value.data` in views. */
export const queueEntries = $computed((): Opaque<QueueEntry[]> => {
  const queue = playback.queue;
  if (!queue) {
    return new Opaque([]);
  }
  const roots = new Map(library.roots.map((root) => [root.id, root]));
  const index = playback.index;
  return new Opaque(
    queue.items.map((item, at) => {
      const root = roots.get(item.rootId);
      const track = root?.tracks.find((one) => one.id === item.trackId);
      return {
        index: at,
        title: track ? track.metadata.title || track.name : item.trackId.split("/").pop() || item.trackId,
        artist: track?.metadata.artist ?? "",
        rootLabel: root?.label ?? "",
        cover: track?.metadata.coverDataUrl ?? null,
        state: at < index ? "played" : at === index ? "current" : "upcoming",
        missing: !track
      };
    })
  );
});

const audio: HTMLAudioElement | null = typeof Audio === "function" ? new Audio() : null;
// The analyser reads the element only when its media is not cross-origin, as it is from the
// desktop app's asset protocol on Windows and its local server on Linux (E4-D5): asked for with
// CORS, those allow it; a blob: URL in the browser is same-origin anyway.
if (audio) {
  audio.crossOrigin = "anonymous";
}

// Bookkeeping, not state: which track the element holds, where its file is,
// the file it opened, and the date the library gave it then.
let loadedKey: string | null = null;
let loaded: { rootId: string; relativePath: string; lastModified?: number } | null = null;
let media: MediaHandle | null = null;

// After a reload: the track to come back to, where in it, and whether it was
// playing (see restorePlayback). Taken by the load of that track.
let resumeAt: { key: string; position: number; play: boolean } | null = null;
// A track to load without playing it: the first one added to an empty queue,
// or the one that became current when the current one left the queue while
// the music was paused. Taken by the load of that track.
let startPaused: string | null = null;
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
// leaves the element as it was. The context runs at the device's own rate
// (one resampling, as the element alone; forcing one would add another) and
// with the latency meant for music: larger buffers, fewer dropouts.
let context: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let bins: Uint8Array<ArrayBuffer> | null = null;

function routeThroughAnalyser(element: HTMLAudioElement): void {
  if (!context) {
    if (typeof AudioContext !== "function") {
      return;
    }
    try {
      const made = new AudioContext({ latencyHint: "playback" });
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
  if (!analyser || !bins || !context) {
    return null;
  }
  analyser.getByteFrequencyData(bins);
  return spectrumBands(bins, bands, context.sampleRate);
}

function release(): void {
  media?.release();
  media = null;
}

let refreshing = false;

/**
 * Opens the loaded track's file again, at the same second and playing if it
 * was, when it changed since it was opened: the browser stops reading a file
 * once it is rewritten (a save, another program), and the element then waits
 * for ever, without an error. Nothing when it did not change, unless `force`
 * (the file was renamed: the old one is gone).
 */
async function refresh(force = false): Promise<void> {
  const key = loadedKey;
  const target = loaded;
  const opened = media;
  if (!audio || !key || !target || !opened || refreshing) {
    return;
  }
  const root = $toRaw(library).roots.find((item) => item.id === target.rootId);
  if (!root) {
    return;
  }
  refreshing = true;
  try {
    if (!force && !(await opened.changed())) {
      return;
    }
    const next = await root.source.openMedia(target.relativePath);
    if (loadedKey !== key || media !== opened) {
      next.release();
      return;
    }
    const position = audio.currentTime;
    const playing = !audio.paused;
    media = next;
    audio.src = next.url;
    audio.currentTime = position;
    opened.release();
    if (playing) {
      await audio.play();
    }
  } catch (error) {
    if (loadedKey === key) {
      playback.error = error instanceof Error ? error.message : t("playback.loadFailed");
    }
  } finally {
    refreshing = false;
  }
}

/** Loads and plays the current track, unless it is the one already loaded. */
async function load(current: NowPlaying | null): Promise<void> {
  const key = current?.key ?? null;
  if (!audio) {
    return;
  }
  if (key === loadedKey) {
    // The same track, saved or found changed since: its file may be new.
    if (current && loaded && current.lastModified !== loaded.lastModified) {
      loaded.lastModified = current.lastModified;
      void refresh();
    }
    return;
  }
  loadedKey = key;
  loaded = current ? { rootId: current.rootId, relativePath: current.relativePath, lastModified: current.lastModified } : null;
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
    const opened = await root.source.openMedia(current.relativePath);
    if (loadedKey !== key) {
      opened.release();
      return;
    }
    media = opened;
    audio.src = opened.url;
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
    if (startPaused === key) {
      startPaused = null;
      return;
    }
    await audio.play();
  } catch (error) {
    if (loadedKey === key && !interrupted(error)) {
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
  // Waiting for data for two seconds while it should play: the file may have
  // been rewritten by another program, which nothing here has noticed yet.
  let stalled: ReturnType<typeof setTimeout> | null = null;
  const settle = () => {
    if (stalled) clearTimeout(stalled);
    stalled = null;
  };
  audio.addEventListener("waiting", () => {
    settle();
    stalled = setTimeout(() => {
      stalled = null;
      if (!audio.paused && audio.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) {
        void refresh();
      }
    }, 2000);
  });
  for (const type of ["playing", "canplay", "pause", "emptied"] as const) {
    audio.addEventListener(type, settle);
  }
  // Once per change of the queue: its queue and index are written one after
  // the other, and in between the old index can point at another track of the
  // new queue; loading on each write would start that track for a moment.
  let loadQueued = false;
  nowPlaying.$on(
    "value",
    () => {
      if (loadQueued) return;
      loadQueued = true;
      queueMicrotask(() => {
        loadQueued = false;
        void load($toRaw(nowPlaying).value);
      });
    },
    { immediate: true }
  );
}

/**
 * Plays `queue` from its `index`-th track; when that track is the one loaded
 * (paused, say, after it was added to an empty queue), it resumes.
 */
export function playQueue(queue: PlaybackQueue, index: number): void {
  startPaused = null;
  playback.queue = queue;
  playback.index = index;
  const item = queue.items[index];
  if (audio && audio.src && audio.paused && item && keyOf(item) === loadedKey) {
    void audio.play().catch((error: unknown) => {
      if (!interrupted(error)) playback.error = error instanceof Error ? error.message : t("playback.loadFailed");
    });
  }
}

function position(): QueuePosition {
  const { queue, index } = $toRaw(playback);
  return { queue, index };
}

/**
 * Puts a new position in place; `paused`: its current track loads without
 * playing. A paused start still pending for the same current track stays
 * (two quick additions to an empty queue must not start the music).
 */
function apply(next: QueuePosition, paused = false): void {
  const item = next.queue?.items[next.index];
  const key = item ? keyOf(item) : null;
  if (paused && key) {
    startPaused = key;
  } else if (startPaused !== key) {
    startPaused = null;
  }
  playback.queue = next.queue;
  playback.index = next.index;
}

/**
 * Tracks to play right after the current one. With nothing queued they
 * become the queue, `sourceLabel` its name, and the first loads paused:
 * nothing starts by itself.
 */
export function playNext(items: QueueItem[], sourceLabel: string): void {
  const was = position();
  apply(playNextIn(was, items, sourceLabel), !was.queue);
}

/** Tracks at the end of the queue; with nothing queued, as `playNext`. */
export function addToQueue(items: QueueItem[], sourceLabel: string): void {
  const was = position();
  apply(addTo(was, items, sourceLabel), !was.queue);
}

/** Removes the queue's `at`-th track; not the current one. */
export function removeFromQueue(at: number): void {
  apply(removeAt(position(), at));
}

/** Moves the queue's `from`-th track to `to`; the current one keeps playing. */
export function moveInQueue(from: number, to: number): void {
  apply(moveTo(position(), from, to));
}

/** Removes every track after the current one. */
export function clearUpcoming(): void {
  apply(clearAfterCurrent(position()));
}

/**
 * Follows tracks of `rootId` renamed (`renames`: old id to new id): the
 * queue keeps them, and the one loaded carries on from its new path, at the
 * same second. Call it in the same moment the library takes the new ids, so
 * the player never sees the track missing.
 */
export function followRename(rootId: string, renames: ReadonlyMap<string, string>): void {
  const queue = $toRaw(playback).queue;
  if (queue && queue.items.some((item) => item.rootId === rootId && renames.has(item.trackId))) {
    playback.queue = {
      ...queue,
      items: queue.items.map((item) => (item.rootId === rootId && renames.has(item.trackId) ? { rootId, trackId: renames.get(item.trackId) as string } : item))
    };
  }
  const trackId = loaded?.rootId === rootId && loadedKey ? loadedKey.slice(rootId.length + 1) : null;
  const renamed = trackId ? renames.get(trackId) : undefined;
  if (loaded && renamed) {
    loadedKey = keyOf({ rootId, trackId: renamed });
    loaded.relativePath = renamed;
    if (startPaused === keyOf({ rootId, trackId: trackId as string })) {
      startPaused = loadedKey;
    }
    void refresh(true);
  }
}

/** Plays the queue's `at`-th track; the current one pauses or resumes. */
export function playAt(at: number): void {
  const { queue, index } = $toRaw(playback);
  if (!queue || at < 0 || at >= queue.items.length) {
    return;
  }
  if (at === index) {
    togglePlay();
    return;
  }
  startPaused = null;
  playback.index = at;
}

/**
 * Takes out of the queue the tracks `gone` matches (a closed root's, tracks
 * removed from the library). If the current one goes, the next one left
 * becomes current, playing if the music was.
 */
export function dropFromQueue(gone: (item: QueueItem) => boolean): void {
  const dropped = dropItems(position(), gone);
  if (dropped.queue === $toRaw(playback).queue && !dropped.currentGone) {
    return;
  }
  apply({ queue: dropped.queue, index: dropped.index }, dropped.currentGone && !$toRaw(playback).playing);
}

/** Pauses or resumes the loaded track. */
export function togglePlay(): void {
  if (!audio?.src) {
    // Still loading a track meant to start paused: it plays once loaded.
    startPaused = null;
    return;
  }
  if (Date.now() - resumedAt < 1000) {
    // This press already resumed the music (resumeOnFirstInteraction).
    return;
  }
  if (audio.paused) {
    void audio.play().catch((error: unknown) => {
      if (!interrupted(error)) playback.error = error instanceof Error ? error.message : t("playback.loadFailed");
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
 * was (see load). Tracks of roots that did not reopen leave the queue; nothing
 * comes back when the current track's root did not.
 */
export function restorePlayback(): void {
  const saved = parsePlaybackState(readSession(SESSION_KEYS.playback));
  const back = saved && restoreQueue(saved, new Set($toRaw(library).roots.map((root) => root.id)));
  if (!saved || !back?.queue) {
    return;
  }
  resumeAt = { key: keyOf(back.queue.items[back.index]), position: saved.position, play: saved.playing };
  playQueue(back.queue, back.index);
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
