import type { Track } from "../types.ts";
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
 * Tracks grouped into albums by artist and album tag, ignoring case; a track
 * with no album tag goes under `untitled`. Year, genre and cover are the
 * album's first track's. Albums are sorted by title in `locale`.
 */
export function groupAlbums(tracks: readonly Track[], untitled: string, locale: string): AlbumGroup[] {
  const albums = new Map<string, { group: AlbumGroup; discs: Map<number, Track[]> }>();

  for (const track of tracks) {
    const album = track.metadata.album.trim();
    const artist = track.metadata.artist.trim();
    const key = `${artist.toLocaleLowerCase(locale)}::${album.toLocaleLowerCase(locale)}`;
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
    const disc = inferDiscNumber(track);
    entry.discs.set(disc, [...(entry.discs.get(disc) ?? []), track]);
  }

  return [...albums.values()]
    .map(({ group, discs }) => ({
      ...group,
      discs: [...discs.entries()]
        .sort(([left], [right]) => left - right)
        .map(([number, discTracks]) => ({
          number,
          tracks: [...discTracks].sort((left, right) => {
            const difference = trackNumberOrder(left) - trackNumberOrder(right);
            return Number.isNaN(difference) ? 0 : difference;
          })
        }))
    }))
    .sort((left, right) => left.title.localeCompare(right.title, locale));
}
