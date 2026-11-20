/**
 * Searching the songs of the open tab: each word typed is looked for in a song's title, artist,
 * album (and album artist) and file name, as written or not: without telling capitals, accents
 * or other marks apart, nor punctuation ("AC/DC" is found by "acdc" and by "ac dc"). A song is
 * found when every word is in it; those whose title begins with what was typed come first, then
 * those whose title has it, then the rest, each in the order given. See
 * RECORD/2026-11-03.deck-design-system.WIP.md (2026-11-20).
 */

/** What a song is searched by. */
export type Searchable = { title: string; artist?: string; album?: string; albumArtist?: string; name?: string };

/** `text` folded for comparing: small letters, no accents or marks, words of letters and digits split by one space. */
export function foldText(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[ßæœøłđ]/g, (letter) => ({ ß: "ss", æ: "ae", œ: "oe", ø: "o", ł: "l", đ: "d" })[letter] ?? letter)
    .replace(/['’`´]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** The words of a query, folded; none for an empty one. */
export function queryWords(query: string): string[] {
  const folded = foldText(query);
  return folded ? folded.split(" ") : [];
}

/** A song made ready to search: its title and all it is searched by, folded once. */
export type Indexed<T> = { song: T; title: string; all: string; glued: string };

/** The songs made ready to search, folded once (kept while the songs are the same). */
export function searchIndex<T extends Searchable>(songs: readonly T[]): Indexed<T>[] {
  return songs.map((song) => {
    const title = foldText(song.title);
    const all = [title, ...[song.artist, song.album, song.albumArtist, song.name].map((part) => foldText(part ?? ""))].join(" ");
    // Joined as written too, so "acdc" finds "AC/DC" (folded "ac dc").
    return { song, title, all, glued: all.replace(/ /g, "") };
  });
}

/** How well an indexed song answers: 0, not at all; 3, its title begins with it; 2, its title has it; 1, it has every word. */
export function rankIndexed(item: Indexed<unknown>, words: readonly string[]): number {
  if (words.length === 0) return 0;
  if (!words.every((word) => item.all.includes(word) || item.glued.includes(word))) return 0;
  const phrase = words.join(" ");
  if (item.title.startsWith(phrase)) return 3;
  if (item.title.includes(phrase)) return 2;
  return 1;
}

/** How well a song answers (see `rankIndexed`). */
export function searchRank(song: Searchable, words: readonly string[]): number {
  return rankIndexed(searchIndex([song])[0], words);
}

/** The indexed songs that answer `query`, best first, at most `limit`; with the count of all that do. */
export function searchIndexed<T>(index: readonly Indexed<T>[], query: string, limit = Infinity): { found: T[]; total: number } {
  const words = queryWords(query);
  if (words.length === 0) return { found: [], total: 0 };
  const ranked: { song: T; rank: number; at: number }[] = [];
  index.forEach((item, at) => {
    const rank = rankIndexed(item, words);
    if (rank > 0) ranked.push({ song: item.song, rank, at });
  });
  ranked.sort((a, b) => b.rank - a.rank || a.at - b.at);
  return { found: ranked.slice(0, limit).map((item) => item.song), total: ranked.length };
}

/** The songs that answer `query` (see `searchIndexed`). */
export function searchSongs<T extends Searchable>(songs: readonly T[], query: string, limit = Infinity): { found: T[]; total: number } {
  return searchIndexed(searchIndex(songs), query, limit);
}

/** A piece of a text, and whether it is where a word of the query is found. */
export type Part = { text: string; hit: boolean };

/** One character folded as `foldText` folds it (a mark gone, a sign a space). */
function foldChar(char: string): string {
  const folded = foldText(char);
  if (folded) return folded;
  return /['’`´]/.test(char) || /^\p{M}+$/u.test(char) ? "" : " ";
}

/**
 * `text` in pieces, those where a word of `query` is found marked (as it is found: without
 * capitals, accents or marks), to light them. Words run together ("acdc" in "AC/DC") are not lit.
 */
export function highlightParts(text: string, query: string): Part[] {
  const words = queryWords(query);
  if (!text) return [];
  if (words.length === 0) return [{ text, hit: false }];
  // The folded text, each of its letters knowing the character of `text` it comes from.
  let folded = "";
  const from: number[] = [];
  const chars = Array.from(text);
  chars.forEach((char, at) => {
    for (const letter of foldChar(char)) {
      folded += letter;
      from.push(at);
    }
  });
  const lit = new Array<boolean>(chars.length).fill(false);
  for (const word of words) {
    for (let at = folded.indexOf(word); at >= 0; at = folded.indexOf(word, at + 1)) {
      for (let i = at; i < at + word.length; i++) lit[from[i]] = true;
    }
  }
  // What folds to nothing goes with what is round it: a mark with its letter, an apostrophe lit
  // inside a word lit on both sides.
  chars.forEach((char, at) => {
    if (foldChar(char) !== "" || at === 0) return;
    lit[at] = /^\p{M}+$/u.test(char) ? lit[at - 1] : lit[at - 1] && !!lit[at + 1];
  });
  const parts: Part[] = [];
  chars.forEach((char, at) => {
    const last = parts[parts.length - 1];
    if (last && last.hit === lit[at]) last.text += char;
    else parts.push({ text: char, hit: lit[at] });
  });
  return parts;
}
