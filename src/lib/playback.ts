// What is playing: the queue, the position in it, and whether audio runs.

import { $reactive } from "jq79";
import type { PlaybackQueue } from "../types";

export const playback = $reactive({
  queue: null as PlaybackQueue | null,
  index: 0,
  playing: false
});
