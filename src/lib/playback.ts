// What is playing: the queue, the position in it, whether audio runs, and
// where in the track it is. lib/player.ts drives the audio and writes here.

import { $reactive } from "jq79";
import type { PlaybackQueue } from "../types";

export const playback = $reactive({
  queue: null as PlaybackQueue | null,
  index: 0,
  playing: false,
  /** Seconds into the current track, and its length (0 until known). */
  position: 0,
  duration: 0,
  /** The second the buffer reaches, while the track streams (0 when unknown; the length when whole). */
  buffered: 0,
  loading: false,
  error: null as string | null
});
