/**
 * A folder's quarantine (the owner, 2026-11-25): a song deleted from a folder (of this device or of
 * a server) is moved into `.jackbird-trash/<day>/<its path>` inside that folder, out of the
 * library's sight, and deleted for good once it has been there 30 days (the next time the folder is
 * read after that). A family library's songs go to the server's own trash instead.
 */

/** The quarantine's folder, at the top of the folder the songs were deleted from. */
export const QUARANTINE_DIR = ".jackbird-trash";

/** How long a song stays in quarantine before it is deleted for good. */
export const QUARANTINE_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;
const dayOf = (now: Date): string => now.toISOString().slice(0, 10);

/** Whether a path is in the quarantine (left out of the library, its playlists and its checks). */
export function inQuarantine(path: string): boolean {
  return path === QUARANTINE_DIR || path.startsWith(`${QUARANTINE_DIR}/`);
}

/** Where a song deleted `now` goes: its path under that day's folder of the quarantine. */
export function quarantinePath(path: string, now: Date): string {
  return `${QUARANTINE_DIR}/${dayOf(now)}/${path.replace(/^\/+/, "")}`;
}

/** The folder a path is in ("" at the top). */
export function folderOf(path: string): string {
  const at = path.lastIndexOf("/");
  return at === -1 ? "" : path.slice(0, at);
}

/**
 * The files of the quarantine that have been there `QUARANTINE_DAYS` days or more on `now` (by the
 * day folder they are in), to delete for good. A path not under a day's folder is left alone.
 */
export function expiredInQuarantine(paths: readonly string[], now: Date, days = QUARANTINE_DAYS): string[] {
  const today = Date.parse(dayOf(now));
  return paths.filter((path) => {
    const match = /^\.jackbird-trash\/(\d{4}-\d{2}-\d{2})\/./.exec(path);
    if (!match) return false;
    const day = Date.parse(match[1]);
    return Number.isFinite(day) && today - day >= days * DAY_MS;
  });
}
