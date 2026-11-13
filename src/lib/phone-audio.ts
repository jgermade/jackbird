// The phone's native player (E6b, crates/player: Android's Media3 in a foreground service) as
// lib/player.ts sees it: shaped like the <audio> element, as lib/native-audio.ts is for the
// desktop's (src, paused, currentTime, duration, play, pause, the same events), so the queue and
// the played counts work the same over it. It is handed the song to play and the songs ahead of it
// at once (`setUpcoming`): with the app in the background, the page may not be able to ask the
// instance for the next one (E6-D1 c), and the player goes through them by itself. What the
// element has no word for comes as events of its own: "advance" (the next song started by itself,
// or from the lock screen) and "fallback" (the player could not play it).
// See RECORD/2026-08-11.musikmatch-rust-migration.WIP.md (E6b, 2026-11-11).

import { addPluginListener, invoke } from "@tauri-apps/api/core";
import type { Sounding } from "./native-audio";
import { output } from "./output";
import { isPhone } from "./platform";

/** A song for the player: the page's key for it, its media URL, and what the lock screen shows. */
export type PhoneSong = { key: string; url: string; title?: string; artist?: string; album?: string; cover?: string | null };

/** What the player says of itself, with each event and when asked. */
type Status = { key?: string | null; playing: boolean; playWhenReady: boolean; position: number; duration?: number; message?: string };

const PLUGIN = "jackbird-player";

/** Whether this app has the native player: Android's, for now (iOS's is E6b's step 2). */
export const phoneAudioAvailable: boolean = isPhone && /Android/.test(navigator.userAgent);

/** How often the position is asked for while it plays, in milliseconds. */
const POLL = 500;

const sameSongs = (one: PhoneSong[], other: PhoneSong[]): boolean =>
  one.length === other.length && one.every((song, at) => song.key === other[at].key && song.url === other[at].url);

export class PhoneAudio extends EventTarget {
  paused = true;
  duration = Number.NaN;
  readyState = 0;
  /** The formats the USB DAC offers bit-perfect, as the player last said (empty: none, or no DAC). */
  offered = "";
  #song: PhoneSong | null = null;
  #upcoming: PhoneSong[] = [];
  #position = 0;
  #timer: ReturnType<typeof setInterval> | null = null;
  #bins: Uint8Array<ArrayBuffer> | null = null;
  #rate = 44100;
  #asked = 0;
  /** The calls, one after the other: a queue set before it is played, a seek before the play. */
  #calls: Promise<unknown> = Promise.resolve();

  constructor() {
    super();
    for (const name of ["state", "advance", "ended", "failed"] as const) {
      void addPluginListener<Status>(PLUGIN, name, (status) => this.#heard(name, status)).catch(() => undefined);
    }
    // What sounds (E6b-D10): as the desktop's native player says it, an event "started" with its
    // format and its way to the device; and, when it is not bit-perfect, what the DAC offers.
    void addPluginListener<Sounding & { offered: string }>(PLUGIN, "sounding", ({ offered, ...sounding }) => {
      if (sounding.key !== this.#song?.key) return;
      this.offered = offered;
      output.offered = offered;
      this.dispatchEvent(new CustomEvent("started", { detail: sounding }));
    }).catch(() => undefined);
  }

  /**
   * The spectrum of what plays (the player's Spectrum.kt) and its rate, as the desktop's native
   * player gives it (lib/native-audio.ts): the last answer, and the next asked for, at most every
   * 25 ms, outside the queue of calls (it changes nothing).
   */
  spectrum(): { bins: Uint8Array<ArrayBuffer>; rate: number } | null {
    const now = Date.now();
    if (!this.paused && now - this.#asked > 25) {
      this.#asked = now;
      void invoke<{ bins: number[] | null; rate?: number }>(`plugin:${PLUGIN}|spectrum`)
        .then((answer) => {
          this.#bins = answer.bins ? new Uint8Array(answer.bins) : null;
          if (answer.rate) this.#rate = answer.rate;
        })
        .catch(() => undefined);
    }
    return this.#bins ? { bins: this.#bins, rate: this.#rate } : null;
  }

  #call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    const call = this.#calls.then(() => invoke<T>(`plugin:${PLUGIN}|${command}`, args));
    this.#calls = call.catch(() => undefined);
    return call;
  }

  /** The song loaded's URL (empty: none), as the element's `src`. */
  get src(): string {
    return this.#song?.url ?? "";
  }

  get currentTime(): number {
    return this.#position;
  }

  set currentTime(seconds: number) {
    this.#position = seconds;
    if (this.#song) void this.#call("seek", { seconds }).catch(() => undefined);
    this.dispatchEvent(new Event("timeupdate"));
  }

  /** Loads a song, paused, at its start; the songs ahead of it go with the next `setUpcoming`. */
  open(song: PhoneSong): void {
    this.#song = song;
    this.#upcoming = [];
    this.#position = 0;
    this.duration = Number.NaN;
    this.readyState = 0;
    this.paused = true;
    this.#stopPolling();
    void this.#call("set_queue", { songs: [song], at: 0, play: false }).catch((error: unknown) => this.#fail(song.key, error));
  }

  /** The songs to follow the one loaded, in order (none: the queue ends with it). */
  setUpcoming(songs: PhoneSong[]): void {
    if (!this.#song || sameSongs(songs, this.#upcoming)) return;
    this.#upcoming = songs;
    void this.#call("set_upcoming", { songs }).catch(() => undefined);
  }

  async play(): Promise<void> {
    if (!this.#song) return;
    this.paused = false;
    await this.#call("play");
    this.dispatchEvent(new Event("play"));
    this.#startPolling();
  }

  pause(): void {
    if (this.paused) return;
    this.paused = true;
    void this.#call("pause").catch(() => undefined);
    this.#stopPolling();
    this.dispatchEvent(new Event("pause"));
  }

  /** `removeAttribute("src")`, as on the element: stops, and the notification goes. */
  removeAttribute(name: string): void {
    if (name !== "src" || !this.#song) return;
    this.#song = null;
    this.#upcoming = [];
    this.paused = true;
    this.#stopPolling();
    void this.#call("stop").catch(() => undefined);
    this.dispatchEvent(new Event("emptied"));
  }

  #fail(key: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.dispatchEvent(new CustomEvent("fallback", { detail: { key, message } }));
  }

  /** The player's word for its song, its length and whether it is meant to play. */
  #take(status: Status): void {
    if (status.duration && status.duration !== this.duration) {
      this.duration = status.duration;
      this.dispatchEvent(new Event("durationchange"));
    }
    if (this.readyState < 4 && status.duration) {
      this.readyState = 4;
      this.dispatchEvent(new Event("canplay"));
    }
    // Paused or resumed from the notification, the lock screen or a headset.
    if (status.playWhenReady === this.paused) {
      this.paused = !status.playWhenReady;
      this.dispatchEvent(new Event(this.paused ? "pause" : "play"));
      if (this.paused) this.#stopPolling();
      else this.#startPolling();
    }
  }

  #heard(event: "state" | "advance" | "ended" | "failed", status: Status): void {
    const song = this.#song;
    if (!song) return;
    if (event === "advance" && status.key && status.key !== song.key) {
      const at = this.#upcoming.findIndex((one) => one.key === status.key);
      if (at < 0) return;
      // The next song started by itself: it is the one loaded now.
      this.#song = this.#upcoming[at];
      this.#upcoming = this.#upcoming.slice(at + 1);
      this.#position = status.position;
      this.duration = Number.NaN;
      this.readyState = 0;
      this.dispatchEvent(new CustomEvent("advance", { detail: status.key }));
      this.#take(status);
    } else if (status.key !== song.key) {
      return;
    } else if (event === "state") {
      this.#take(status);
    } else if (event === "ended") {
      this.paused = true;
      this.#stopPolling();
      if (Number.isFinite(this.duration)) this.#position = this.duration;
      this.dispatchEvent(new Event("ended"));
    } else if (event === "failed") {
      this.#fail(song.key, status.message ?? "");
    }
  }

  #startPolling(): void {
    this.#stopPolling();
    this.#timer = setInterval(() => {
      void invoke<Status>(`plugin:${PLUGIN}|status`)
        .then((status) => {
          if (status.key && status.key === this.#song?.key && !this.paused) {
            this.#position = status.position;
            this.#take(status);
            this.dispatchEvent(new Event("timeupdate"));
          }
        })
        .catch(() => undefined);
    }, POLL);
  }

  #stopPolling(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }
}
