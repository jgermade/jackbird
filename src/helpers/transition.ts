/**
 * How one song follows another (Preferences › Sound): as it always did, without a pause between
 * them (the next one loaded ahead and started as the first ends), or crossfaded (the next one
 * fading in over the last seconds of the first, which fades out). The three players follow it:
 * the browser's two elements (lib/twin-audio.ts), the desktop's engine (crates/audio) and
 * Android's (crates/player). See RECORD/2026-11-03.deck-design-system.WIP.md (2026-11-23).
 */

import type { Transition } from "../types.ts";

/** The ways, as Settings lists them. */
export const TRANSITIONS: readonly Transition[] = ["normal", "gapless", "crossfade"];

/** The way until one is chosen: gapless (the owner, 2026-11-23). */
export const DEFAULT_TRANSITION: Transition = "gapless";

/** The way a saved value names, else the default. */
export function transitionOf(value: unknown): Transition {
  return TRANSITIONS.find((one) => one === value) ?? DEFAULT_TRANSITION;
}

/** The crossfade's lengths to choose from, in seconds, and the default. */
export const CROSSFADE_MIN = 1;
export const CROSSFADE_MAX = 12;
export const CROSSFADE_DEFAULT = 6;

/** The crossfade's length a saved value names (whole seconds, 1 to 12), else the default. */
export function crossfadeSecondsOf(value: unknown): number {
  const seconds = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
  if (!Number.isFinite(seconds)) return CROSSFADE_DEFAULT;
  return Math.min(CROSSFADE_MAX, Math.max(CROSSFADE_MIN, Math.round(seconds)));
}

/**
 * How long two songs overlap: the crossfade's length, but never more than half of either song (a
 * short one is not all fade). 0 when one of them has no known length.
 */
export function overlapOf(seconds: number, ending: number, starting: number): number {
  if (!(ending > 0) || !(starting > 0)) return 0;
  return Math.max(0, Math.min(seconds, ending / 2, starting / 2));
}

/**
 * The two songs' levels `progress` (0 to 1) into a crossfade: equal power, so the sum sounds as
 * loud as either song alone (the ending one's falls as a cosine, the starting one's rises as a sine).
 */
export function fadeLevels(progress: number): { ending: number; starting: number } {
  const at = Math.min(1, Math.max(0, progress)) * (Math.PI / 2);
  return { ending: Math.cos(at), starting: Math.sin(at) };
}

/** What to do about the next song now. */
export type TransitionStep =
  /** Nothing yet: the song has more than `lead` seconds left. */
  | { kind: "wait" }
  /** Start the next song in `delay` seconds (gapless: as this one ends). */
  | { kind: "start"; delay: number }
  /** Start the next song now, fading over `overlap` seconds. */
  | { kind: "fade"; overlap: number };

/** How long before a song's end a gapless start is timed (a timer, not the element's `timeupdate`, sets it to the moment). */
export const GAPLESS_LEAD = 1;

/**
 * What to do now about the next song, `remaining` seconds before the end of the one playing
 * (`duration` long), the next one `next` seconds long (0 when not known yet).
 */
export function transitionStep(way: Transition, remaining: number, duration: number, next: number, seconds: number): TransitionStep {
  if (way === "normal" || !(remaining >= 0)) return { kind: "wait" };
  if (way === "crossfade") {
    const overlap = overlapOf(seconds, duration, next);
    if (overlap > 0) return remaining <= overlap ? { kind: "fade", overlap } : { kind: "wait" };
  }
  // Gapless, or a crossfade with a song of no known length: started as this one ends.
  return remaining <= GAPLESS_LEAD ? { kind: "start", delay: remaining } : { kind: "wait" };
}
