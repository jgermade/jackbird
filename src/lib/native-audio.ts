// The desktop app's native player (E5, crates/audio behind src-tauri/src/audio.rs)
// as lib/player.ts sees it: shaped like the <audio> element it already
// drives (src, paused, currentTime, duration, play, pause, the same events),
// so the queue, the restore after a reload and the played counts work the
// same over both. What the element has no word for comes as events of its
// own: "started" (a song began sounding, with its format and its way to the
// device), "advance" (the next song began by itself, gapless) and "fallback"
// (the native player could not play it: the embedded output takes over).
// See RECORD/2026-08-11.musikmatch-rust-migration.WIP.md (E5).

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { PcmFormat, Route } from "../helpers/output";

/** A file of an open root, and the player's key for it. */
export type NativeTrack = { root: string; path: string; key: string };

/** What sounds: its format and where it goes. */
export type Sounding = { key: string; codec: string; format: PcmFormat; route: Route };

type NativeEvent =
  | { event: "started"; key: string; codec: string; format: PcmFormat; route: Route; duration: number | null }
  | { event: "ended"; key: string }
  | { event: "failed"; key: string; message: string };

type Status = { key: string | null; playing: boolean; position: number };

/** How often the position is asked for while it plays, in milliseconds. */
const POLL = 200;

export class NativeAudio extends EventTarget {
  paused = true;
  duration = Number.NaN;
  readyState = 0;
  /** What sounds now; null until a song starts. */
  sounding: Sounding | null = null;
  #track: NativeTrack | null = null;
  #next: NativeTrack | null = null;
  #position = 0;
  #timer: ReturnType<typeof setInterval> | null = null;
  #bins: Uint8Array<ArrayBuffer> | null = null;
  #rate = 0;
  #asked = 0;

  constructor() {
    super();
    void listen<NativeEvent>("audio", (event) => this.#heard(event.payload));
  }

  /** The track loaded, as a string (empty: none), as the element's `src`. */
  get src(): string {
    return this.#track ? `${this.#track.root}\n${this.#track.path}` : "";
  }

  get currentTime(): number {
    return this.#position;
  }

  set currentTime(seconds: number) {
    this.#position = seconds;
    if (this.#track) void invoke("audio_seek", { seconds }).catch(() => undefined);
    this.dispatchEvent(new Event("timeupdate"));
  }

  /** Loads a track, paused, at its start. */
  open(track: NativeTrack): void {
    this.#track = track;
    this.#next = null;
    this.#position = 0;
    this.duration = Number.NaN;
    this.readyState = 0;
    this.paused = true;
    this.sounding = null;
    this.#stopPolling();
    void invoke("audio_load", { root: track.root, path: track.path, key: track.key, at: 0, play: false }).catch((error: unknown) =>
      this.#fail(track.key, error)
    );
  }

  async play(): Promise<void> {
    if (!this.#track) return;
    this.paused = false;
    await invoke("audio_play");
    this.dispatchEvent(new Event("play"));
    this.#startPolling();
  }

  pause(): void {
    if (this.paused) return;
    this.paused = true;
    void invoke("audio_pause").catch(() => undefined);
    this.#stopPolling();
    this.dispatchEvent(new Event("pause"));
  }

  /** `removeAttribute("src")`, as on the element: stops, and lets the device go. */
  removeAttribute(name: string): void {
    if (name !== "src" || !this.#track) return;
    this.#track = null;
    this.#next = null;
    this.paused = true;
    this.sounding = null;
    this.#stopPolling();
    void invoke("audio_stop").catch(() => undefined);
    this.dispatchEvent(new Event("emptied"));
  }

  /** The song to follow the one loaded without a gap (null: none). */
  setNext(track: NativeTrack | null): void {
    if (track?.key === this.#next?.key && track?.path === this.#next?.path && track?.root === this.#next?.root) return;
    this.#next = track;
    void invoke("audio_next", track ? { root: track.root, path: track.path, key: track.key } : { root: null, path: null, key: null }).catch(
      () => undefined
    );
  }

  /** The spectrum of what the device took last, and its rate; asks for the next one. */
  spectrum(): { bins: Uint8Array<ArrayBuffer>; rate: number } | null {
    const now = Date.now();
    if (!this.paused && now - this.#asked > 25) {
      this.#asked = now;
      void invoke<{ bins: number[]; rate: number } | null>("audio_spectrum")
        .then((answer) => {
          if (answer) {
            this.#bins = new Uint8Array(answer.bins);
            this.#rate = answer.rate;
          }
        })
        .catch(() => undefined);
    }
    return this.#bins ? { bins: this.#bins, rate: this.#rate } : null;
  }

  #fail(key: string, error: unknown): void {
    const message = error instanceof Error ? error.message : typeof error === "object" && error && "message" in error ? String(error.message) : String(error);
    this.dispatchEvent(new CustomEvent("fallback", { detail: { key, message } }));
  }

  #heard(event: NativeEvent): void {
    const track = this.#track;
    if (!track) return;
    if (event.event === "started") {
      if (event.key !== track.key) {
        if (this.#next?.key !== event.key) return;
        // The next song started by itself: it is the one loaded now.
        this.#track = this.#next;
        this.#next = null;
        this.#position = 0;
        this.dispatchEvent(new CustomEvent("advance", { detail: event.key }));
      }
      this.duration = event.duration ?? Number.NaN;
      this.readyState = 4;
      this.sounding = { key: event.key, codec: event.codec, format: event.format, route: event.route };
      this.dispatchEvent(new CustomEvent("started", { detail: this.sounding }));
      this.dispatchEvent(new Event("durationchange"));
      this.dispatchEvent(new Event("canplay"));
    } else if (event.event === "ended" && event.key === track.key) {
      this.paused = true;
      this.#stopPolling();
      if (Number.isFinite(this.duration)) this.#position = this.duration;
      this.dispatchEvent(new Event("ended"));
    } else if (event.event === "failed" && (event.key === track.key || event.key === this.#next?.key)) {
      if (event.key === this.#next?.key) {
        this.#next = null;
        return;
      }
      this.#fail(event.key, event.message);
    }
  }

  #startPolling(): void {
    this.#stopPolling();
    this.#timer = setInterval(() => {
      void invoke<Status>("audio_status")
        .then((status) => {
          if (status.key && status.key === this.#track?.key && !this.paused) {
            this.#position = status.position;
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
