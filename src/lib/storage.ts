// Every localStorage key the app uses, in one place. Renaming the app changes
// these, and a rename has to carry the old values over (a migration), or
// everyone's saved choices reset. See RECORD/2026-11-03.deck-design-system.WIP.md.

export const STORAGE_KEYS = {
  theme: "mp3-manager.theme",
  language: "mp3-manager.language"
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
