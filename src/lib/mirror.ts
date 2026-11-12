// The landing page's two embedded apps as one player. The windows (`?embed`) play; the phone
// (`?embed=phone`) follows them: over a BroadcastChannel (the two frames share the origin) the
// windows tell the phone what they play (the queue and the track, whether it plays, where it is,
// what the display shows, the spectrum's levels), and the phone tells the windows what it changes
// (the queue, the track, repeat and shuffle) and its play key. The phone then plays nothing
// itself. A phone with no windows to answer it (the frame opened alone) plays by itself after a
// moment. See RECORD/2026-11-12.landing-page.WIP.md (2026-11-12 19:40 UTC).

import { $reactive, $toRaw } from "jq79";
import { embedKind } from "./platform";
import { playback } from "./playback";

const CHANNEL = "jackbird:embed";
/** How long the phone waits for the windows before playing by itself. */
const ALONE_AFTER = 3000;

/** Whether this frame follows another one's player (the phone, while the windows answer). */
export const mirror = $reactive({ following: embedKind === "phone" });

let channel: BroadcastChannel | null = null;
let heard: { bins: Uint8Array; rate: number } | null = null;

/** The spectrum the windows last sent, while following. */
export function mirroredSpectrum(): { bins: Uint8Array; rate: number } | null {
  return heard;
}

/** Tells the windows to press their play key ("toggle") or to play ("play"). */
export function sendCommand(name: "toggle" | "play"): void {
  channel?.postMessage({ type: "command", name });
}

type Order = { queue: unknown; index: number; repeat: string; shuffle: boolean; order: number[] };

const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value ?? null));
const orderNow = (): Order => {
  const raw = $toRaw(playback);
  return plain({ queue: raw.queue, index: raw.index, repeat: raw.repeat, shuffle: raw.shuffle, order: raw.order });
};

/**
 * Joins this frame to the other one. On the windows: answered at once (true). On the phone: true
 * once the windows answer, false if they do not, and then it plays by itself.
 */
export async function startMirror(): Promise<boolean> {
  if (!embedKind || typeof BroadcastChannel !== "function") {
    mirror.following = false;
    return embedKind !== "phone";
  }
  const player = await import("./player");
  const leading = embedKind === "windows";
  channel = new BroadcastChannel(CHANNEL);

  // The order (queue, track, repeat, shuffle) goes both ways, once per moment (the queue and its
  // track are written one after the other: never half of it); what was just received is not sent back.
  let seen = "";
  let joined = leading;
  let applying = false;
  let pending = false;
  const applyOrder = (order: Order) => {
    applying = true;
    Object.assign(playback, { queue: order.queue, index: order.index, repeat: order.repeat, shuffle: order.shuffle, order: order.order });
    applying = false;
    seen = JSON.stringify(orderNow());
  };
  const sendOrder = () => {
    pending = false;
    const order = orderNow();
    const text = JSON.stringify(order);
    if (text === seen || !joined) return;
    seen = text;
    channel?.postMessage({ type: "order", order });
  };
  playback.$effect(() => {
    void playback.queue;
    void playback.index;
    void playback.repeat;
    void playback.shuffle;
    void playback.order;
    if (applying || pending) return;
    pending = true;
    queueMicrotask(sendOrder);
  });

  if (leading) {
    const status = () => {
      const raw = $toRaw(playback);
      const stream = $toRaw(player.stream);
      return plain({ playing: raw.playing, position: raw.position, duration: raw.duration, buffered: raw.buffered, loading: raw.loading, error: raw.error, stream: { key: stream.key, info: stream.info } });
    };
    playback.$effect(() => {
      void playback.playing;
      void playback.position;
      void playback.duration;
      void playback.loading;
      void playback.error;
      channel?.postMessage({ type: "status", status: status() });
    });
    player.stream.$effect(() => {
      void player.stream.info;
      channel?.postMessage({ type: "status", status: status() });
    });
    // The spectrum's levels, twenty times a second while it plays.
    setInterval(() => {
      if (!$toRaw(playback).playing) return;
      const levels = player.spectrumBins();
      if (levels) channel?.postMessage({ type: "spectrum", ...levels });
    }, 50);
    channel.addEventListener("message", ({ data }) => {
      if (data?.type === "hello") {
        channel?.postMessage({ type: "order", order: orderNow() });
        channel?.postMessage({ type: "status", status: status() });
      } else if (data?.type === "order") {
        applyOrder(data.order);
      } else if (data?.type === "command" && data.name === "toggle") {
        player.togglePlay();
      } else if (data?.type === "command" && data.name === "play") {
        player.resume();
      }
    });
    return true;
  }

  // The phone: it follows once the windows answer.
  return new Promise<boolean>((resolve) => {
    // Asked again until they answer: the windows' frame may not be listening yet.
    const asking = setInterval(() => channel?.postMessage({ type: "hello" }), 500);
    const alone = setTimeout(() => {
      clearInterval(asking);
      mirror.following = false;
      channel?.close();
      channel = null;
      player.playHere();
      resolve(false);
    }, ALONE_AFTER);
    channel?.addEventListener("message", ({ data }) => {
      if (data?.type === "order") {
        applyOrder(data.order);
        if (!joined) {
          joined = true;
          clearInterval(asking);
          clearTimeout(alone);
          resolve(true);
        }
      } else if (data?.type === "status") {
        const { stream, ...status } = data.status;
        Object.assign(playback, status);
        Object.assign(player.stream, stream);
      } else if (data?.type === "spectrum") {
        heard = { bins: data.bins, rate: data.rate };
      }
    });
    channel?.postMessage({ type: "hello" });
  });
}
