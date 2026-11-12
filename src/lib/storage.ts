// Every localStorage key the app uses, in one place. Renaming the app changes
// these, and a rename has to carry the old values over (a migration), or
// everyone's saved choices reset. See RECORD/2026-11-03.deck-design-system.WIP.md.

export const STORAGE_KEYS = {
  theme: "mp3-manager.theme",
  language: "mp3-manager.language",
  renamePattern: "mp3-manager.renamePattern",
  output: "mp3-manager.output",
  outputDevice: "mp3-manager.outputDevice",
  /** An Android phone's "Bit-perfect to a USB DAC" (E6b-D10). */
  phoneBitPerfect: "jackbird.phoneBitPerfect",
  /** The library pane's width beside the album sheet, in rem (src/helpers/split.ts). */
  splitWidth: "jackbird.splitWidth"
} as const;

/**
 * Every sessionStorage key: what belongs to this tab and should survive its
 * reload, not reach the next visit (the music playing, the view).
 */
export const SESSION_KEYS = {
  playback: "mp3-manager.playback",
  view: "mp3-manager.view"
} as const;

/** The stored value, or null when there is none or storage is unavailable. */
export function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Stores a value; a failure (private browsing, a sandbox) only loses persistence. */
export function writeStored(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // The value still applies for this visit.
  }
}

/** A value kept for this tab, or null when there is none or session storage is unavailable. */
export function readSession(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Keeps a value for this tab; a failure only loses it across a reload. */
export function writeSession(key: string, value: string): void {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    // Nothing to keep it in.
  }
}
