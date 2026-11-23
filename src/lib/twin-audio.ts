// The browser's player (the webview's too, in the embedded output): two <audio> elements, shaped
// like one for lib/player.ts (src, paused, currentTime, duration, buffered, play, pause, the same
// events), as lib/native-audio.ts and lib/phone-audio.ts are. One plays the loaded song; the other
// holds the next one, loaded ahead (`setNext`), so that it can start without a pause as the first
// ends (gapless), or fade in over its last seconds while the first fades out (crossfade):
// helpers/transition.ts says when. The next song starting is told as "advance" (its key), as the
// native players tell theirs, and the queue moves on to it. As it always was ("normal"), nothing
// is loaded ahead and the song's end is told as `ended`.
// See RECORD/2026-11-03.deck-design-system.WIP.md (2026-11-23).

import { fadeLevels, transitionStep } from "../helpers/transition";
import type { Transition } from "../types";

/** A song for it: its media URL, and the page's key for it. */
export type TwinSong = { url: string; key: string };

/** The events of the element playing that are its own (the element fading out says none). */
const FORWARDED = ["play", "pause", "timeupdate", "durationchange", "progress", "seeked", "waiting", "playing", "canplay", "emptied", "error"] as const;

/** How often the levels move during a crossfade, in milliseconds. */
const FADE_STEP = 40;

export class TwinAudio extends EventTarget {
  #active: HTMLAudioElement;
  #spare: HTMLAudioElement;
  /** The element ending, while the next one fades in (or, gapless, plays its last milliseconds). */
  #ending: HTMLAudioElement | null = null;
  /** The next song, loaded in the spare element (or waiting for it while one is ending). */
  #next: TwinSong | null = null;
  #way: Transition = "normal";
  #seconds = 6;
  /** The gapless start, timed to the song's end. */
  #timer: ReturnType<typeof setTimeout> | null = null;
  #fade: ReturnType<typeof setInterval> | null = null;
  #overlap = 0;
  /** Done once the element ending is let go (its media may be released then). */
  #onEnded: (() => void)[] = [];
  /** Each element's level, when they sound through Web Audio (`route`). */
  #gains = new Map<HTMLAudioElement, GainNode>();

  constructor() {
    super();
    this.#active = TwinAudio.#element();
    this.#spare = TwinAudio.#element();
    for (const element of [this.#active, this.#spare]) this.#listen(element);
  }

  static #element(): HTMLAudioElement {
    const element = new Audio();
    // The analyser reads it only when its media is not cross-origin (lib/player.ts).
    element.crossOrigin = "anonymous";
    element.preload = "auto";
    return element;
  }

  #listen(element: HTMLAudioElement): void {
    for (const type of FORWARDED) {
      element.addEventListener(type, () => {
        if (element === this.#active) this.dispatchEvent(new Event(type));
      });
    }
    element.addEventListener("timeupdate", () => {
      if (element === this.#active) this.#watch();
    });
    element.addEventListener("ended", () => {
      if (element === this.#ending) {
        this.#letGo();
        return;
      }
      if (element !== this.#active) return;
      // Its end reached before the timer (a timer held back in a background tab): the next one now.
      if (this.#way !== "normal" && this.#nextReady()) {
        this.#begin(0);
        this.#letGo();
        return;
      }
      this.dispatchEvent(new Event("ended"));
    });
  }

  /** How one song follows another, and the crossfade's length in seconds. */
  configure(way: Transition, seconds: number): void {
    this.#way = way;
    this.#seconds = seconds;
    if (way === "normal") this.setNext(null);
  }

  /**
   * Sounds through Web Audio into `into` (the analyser), each element through a level of its own,
   * which a crossfade moves; without it, the elements' own volume does.
   */
  route(context: AudioContext, into: AudioNode): void {
    for (const element of [this.#active, this.#spare, this.#ending]) {
      if (!element || this.#gains.has(element)) continue;
      const gain = context.createGain();
      context.createMediaElementSource(element).connect(gain);
      gain.connect(into);
      this.#gains.set(element, gain);
    }
  }

  #level(element: HTMLAudioElement, level: number): void {
    const gain = this.#gains.get(element);
    if (gain) gain.gain.value = level;
    else element.volume = Math.min(1, Math.max(0, level));
  }

  /** The element playing, for what only an element has (lib/player.ts's first interaction). */
  get element(): HTMLAudioElement {
    return this.#active;
  }

  get src(): string {
    return this.#active.getAttribute("src") ? this.#active.src : "";
  }

  /** The loaded song's media (a song opened again keeps the next one loaded ahead). */
  set src(url: string) {
    this.#stopTimer();
    this.#letGo();
    this.#level(this.#active, 1);
    this.#active.src = url;
  }

  get paused(): boolean {
    return this.#active.paused;
  }

  get currentTime(): number {
    return this.#active.currentTime;
  }

  set currentTime(seconds: number) {
    // A seek during a crossfade ends it: the song ending goes.
    this.#stopTimer();
    this.#letGo();
    this.#level(this.#active, 1);
    this.#active.currentTime = seconds;
  }

  get duration(): number {
    return this.#active.duration;
  }

  get readyState(): number {
    return this.#active.readyState;
  }

  get buffered(): TimeRanges {
    return this.#active.buffered;
  }

  async play(): Promise<void> {
    if (this.#ending) void this.#ending.play().catch(() => undefined);
    await this.#active.play();
  }

  pause(): void {
    this.#stopTimer();
    this.#ending?.pause();
    this.#active.pause();
  }

  /** `removeAttribute("src")`, as on an element: nothing loaded, the next one forgotten too. */
  removeAttribute(name: string): void {
    if (name !== "src") return;
    this.#stopTimer();
    this.#letGo();
    this.setNext(null);
    this.#active.removeAttribute("src");
    this.#active.load();
    this.#level(this.#active, 1);
  }

  /** The song to follow the loaded one, loaded ahead (none: the queue ends with it). */
  setNext(song: TwinSong | null): void {
    if (song?.key === this.#next?.key && song?.url === this.#next?.url) return;
    this.#stopTimer();
    this.#next = song;
    // While one is ending, the spare element is that one: the next is loaded once it is let go.
    if (this.#ending) return;
    this.#load(song);
  }

  #load(song: TwinSong | null): void {
    const spare = this.#spare;
    spare.pause();
    this.#level(spare, 1);
    if (song) {
      spare.src = song.url;
      spare.load();
    } else if (spare.getAttribute("src")) {
      spare.removeAttribute("src");
      spare.load();
    }
  }

  /** Runs `done` once the song ending is let go (at once when none is ending). */
  whenEnded(done: () => void): void {
    if (this.#ending) this.#onEnded.push(done);
    else done();
  }

  #nextReady(): boolean {
    return !!this.#next && !this.#ending && this.#spare.getAttribute("src") !== null && this.#spare.readyState >= HTMLMediaElement.HAVE_METADATA;
  }

  /** On each `timeupdate` of the song playing: whether the next one is to start now, or soon. */
  #watch(): void {
    if (this.#way === "normal" || this.#active.paused || this.#timer || !this.#nextReady()) return;
    const duration = this.#active.duration;
    const remaining = duration - this.#active.currentTime;
    const step = transitionStep(this.#way, remaining, duration, this.#spare.duration, this.#seconds);
    if (step.kind === "fade") {
      this.#begin(step.overlap);
    } else if (step.kind === "start") {
      // `timeupdate` comes every quarter of a second or so: the start is timed to the end itself.
      this.#timer = setTimeout(() => {
        this.#timer = null;
        if (!this.#active.paused && this.#nextReady()) this.#begin(0);
      }, Math.max(0, step.delay * 1000 - 15));
    }
  }

  /** The next song starts: it is the one playing now, fading in over `overlap` seconds (0: gapless). */
  #begin(overlap: number): void {
    const next = this.#next;
    if (!next) return;
    const ending = this.#active;
    this.#active = this.#spare;
    this.#spare = ending;
    this.#ending = ending;
    this.#next = null;
    this.#overlap = overlap;
    this.#level(this.#active, overlap > 0 ? 0 : 1);
    void this.#active.play().catch(() => undefined);
    if (overlap > 0) {
      this.#fade = setInterval(() => this.#step(), FADE_STEP);
    }
    this.dispatchEvent(new CustomEvent("advance", { detail: next.key }));
    for (const type of ["durationchange", "timeupdate", "play"] as const) this.dispatchEvent(new Event(type));
  }

  /** The crossfade's levels, by where the song starting is in it. */
  #step(): void {
    const ending = this.#ending;
    if (!ending) return;
    const progress = this.#active.currentTime / this.#overlap;
    const levels = fadeLevels(progress);
    this.#level(this.#active, levels.starting);
    this.#level(ending, levels.ending);
    if (progress >= 1) this.#letGo();
  }

  /** The song ending goes: its element is the spare one again, given the next song if one waits. */
  #letGo(): void {
    if (this.#fade) clearInterval(this.#fade);
    this.#fade = null;
    const ending = this.#ending;
    if (!ending) return;
    this.#ending = null;
    this.#level(this.#active, 1);
    ending.pause();
    ending.removeAttribute("src");
    ending.load();
    this.#level(ending, 1);
    const done = this.#onEnded;
    this.#onEnded = [];
    for (const one of done) one();
    if (this.#next) this.#load(this.#next);
  }

  #stopTimer(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }
}
