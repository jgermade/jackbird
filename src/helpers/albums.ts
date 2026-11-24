import type { Track } from "../types.ts";
import { isCompilation } from "./metadata.ts";
import { compareText } from "./compare.ts";
import { inferDiscNumber, trackNumberOrder } from "./tracks.ts";

export type AlbumDisc = {
  number: number;
  /** In track-number order; tracks without one last, as they came. */
  tracks: Track[];
};

export type AlbumGroup = {
  key: string;
  title: string;
  artist: string;
  year: string;
  genre: string;
  coverDataUrl: string | null;
  /** In disc-number order. */
  discs: AlbumDisc[];
};

/**
 * Tracks grouped into albums by album artist (else artist; a compilation's
 * tracks together) and album tag, ignoring case; a track
 * with no album tag goes under `untitled`. Year, genre and cover are the
 * album's first track's. Albums are sorted by title in `locale`; `byYear`, by year first (Albums by
 * artist: an artist's albums in the order they came out).
 */
export function groupAlbums(tracks: readonly Track[], untitled: string, locale: string, byYear = false): AlbumGroup[] {
  const albums = new Map<string, { group: AlbumGroup; discs: Map<number, Track[]> }>();

  for (const track of tracks) {
    const album = track.metadata.album.trim();
    // Who the album is by: its album artist; a compilation's tracks, by many, stay together.
    const albumArtist = track.metadata.albumArtist.trim();
    const artist = albumArtist || track.metadata.artist.trim();
    const by = albumArtist || (isCompilation(track.metadata) ? "\u0000compilation" : artist);
    const key = `${by.toLocaleLowerCase(locale)}::${album.toLocaleLowerCase(locale)}`;
    let entry = albums.get(key);
    if (!entry) {
      entry = {
        group: {
          key,
          title: album || untitled,
          artist,
          year: track.metadata.year,
          genre: track.metadata.genre,
          coverDataUrl: track.metadata.coverDataUrl,
          discs: []
        },
        discs: new Map()
      };
      albums.set(key, entry);
    }
    // An album shows the first cover one of its tracks has: some of its tracks may have none.
    if (!entry.group.coverDataUrl && track.metadata.coverDataUrl) entry.group.coverDataUrl = track.metadata.coverDataUrl;
    // And the first year: the album's place when sorted by year.
    if (!entry.group.year.trim() && track.metadata.year.trim()) entry.group.year = track.metadata.year;
    const disc = inferDiscNumber(track);
    const onDisc = entry.discs.get(disc);
    if (onDisc) onDisc.push(track);
    else entry.discs.set(disc, [track]);
  }

  return [...albums.values()]
    .map(({ group, discs }) => ({
      ...group,
      discs: [...discs.entries()]
        .sort(([left], [right]) => left - right)
        .map(([number, discTracks]) => ({
          number,
          // By number; tracks with none (or the same) by file name, as the tree lists them.
          tracks: [...discTracks].sort((left, right) => {
            const difference = trackNumberOrder(left) - trackNumberOrder(right);
            return (Number.isNaN(difference) ? 0 : difference) || compareText(left.name, right.name, locale);
          })
        }))
    }))
    .sort((left, right) => (byYear ? yearOrder(left.year) - yearOrder(right.year) : 0) || compareText(left.title, right.title, locale));
}

/**
 * Where a year tag puts an album, oldest first: its first four digits (a date's year); one with
 * none, or a tag that is not a year, after them all.
 */
export function yearOrder(year: string | undefined): number {
  const found = /^\s*(\d{4})/.exec(year ?? "");
  return found ? Number(found[1]) : Number.MAX_SAFE_INTEGER;
}
