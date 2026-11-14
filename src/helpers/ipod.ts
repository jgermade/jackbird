/**
 * Sending songs to an iPod, worked out before anything is sent: which files can
 * go (MP3s: jackbird writes no other format to an iPod yet), and which look
 * like songs the iPod has already (the same title and artist, case, accents and
 * punctuation aside), so that a duplicate is the person's choice and not a
 * surprise. See RECORD/2026-11-14.ipod-sync.WIP.md (the panel).
 */

/** A song as compared: its title and artist. */
export type SongName = { title: string; artist: string };

/** A name in lower case, without accents, spaces or punctuation: "Don’t Stop" and "dont stop" match. */
export function folded(name: string): string {
  return name
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
}

/** The key two songs match by. */
export function songKey(song: SongName): string {
  return `${folded(song.title)}\u0000${folded(song.artist)}`;
}

/**
 * The positions of the `candidates` that look like songs already in `existing`
 * (or like an earlier candidate: one file sent twice). A song with no title is
 * never a duplicate: there is nothing to tell it by.
 */
export function likelyDuplicates(candidates: SongName[], existing: SongName[]): number[] {
  const seen = new Set(existing.filter((song) => folded(song.title)).map(songKey));
  const out: number[] = [];
  candidates.forEach((song, index) => {
    if (!folded(song.title)) return;
    const key = songKey(song);
    if (seen.has(key)) out.push(index);
    seen.add(key);
  });
  return out;
}

/** Whether a file can be sent to an iPod: an MP3. */
export function isSendable(path: string): boolean {
  return path.toLowerCase().endsWith(".mp3");
}
