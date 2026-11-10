// When a play counts (F3): once the song has played half its length, or four
// minutes of a longer one, as most players count. Pure, for lib/player.ts.

/** Four minutes. */
export const PLAY_CAP_SECONDS = 240;

/** Whether `position` seconds into a song of `duration` seconds is a play. */
export function countsAsPlayed(position: number, duration: number): boolean {
  if (!(duration > 0) || !Number.isFinite(position)) return false;
  return position >= Math.min(duration / 2, PLAY_CAP_SECONDS);
}

/** The library paths a playlist of one's own folder lists (`../Music/a.mp3` → `Music/a.mp3`). */
export function ownPlaylistPaths(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => line.replace(/^\.\.\//, ""));
}
