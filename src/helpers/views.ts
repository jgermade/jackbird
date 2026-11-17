/**
 * The library's views other than Files, as the same flat rows the tree
 * draws: groups (artists, albums, playlists) that open into their tracks,
 * or a flat list (Songs). A group row carries its tracks' ids in the order
 * they play, and its key is also what opens and closes it (kept in the
 * root's `expandedAlbums`, beside the folders' paths). See
 * RECORD/2026-11-04.github-actions-workflows.WIP.md (22:00 and W6's plan).
 */

import { codecLabel } from "./formats.ts";
import type { LibraryView, Track, Playlist, WizardTreeRow } from "../types.ts";
import { isCompilation } from "./metadata.ts";
import { compareText } from "./compare.ts";
import { orderDetailPlaylist } from "./tracks.ts";

/** The words and the order a view needs. */
export type ViewLabels = {
  unknownArtist: string;
  unknownAlbum: string;
  variousArtists: string;
  missing: string;
  locale: string;
};

type Group = { key: string; label: string; meta: string; tracks: Track[]; known: boolean };

const DISC_FOLDER = /^(?:cd|disc)[ _-]?\d+$/i;

/** An iPod's music folders (`iPod_Control/Music/F00` to `F49`): its songs are spread over them at random. */
const IPOD_FOLDER = /^ipod_control\/music\/f\d+\//i;

/**
 * The folder an album is in: a track's folder, its parent when that is a "Disc N" or "CD N" one.
 * None for an iPod's song: its folder says nothing of its album, which its tags alone tell.
 */
export function albumFolder(track: Pick<Track, "relativePath">): string {
  if (IPOD_FOLDER.test(track.relativePath)) return "";
  const folders = track.relativePath.split("/").slice(0, -1);
  if (folders.length > 0 && DISC_FOLDER.test(folders[folders.length - 1])) {
    folders.pop();
  }
  return folders.join("/");
}

/** The key of a track's artist's group. */
export function artistKey(track: Pick<Track, "metadata">): string {
  return `@artist:${track.metadata.artist.trim().toLowerCase()}`;
}

/** An artist's name as their picture is kept by (`MetaSnapshot.artists`): without case or spaces round it. */
export function artistName(name: string): string {
  return name.trim().toLowerCase();
}

/** The artist an artist's group key names (`@artist:…`), as their picture is kept by; null for another key. */
export function artistOfKey(key: string): string | null {
  return key.startsWith("@artist:") ? key.slice("@artist:".length) : null;
}

/** The key of a track's album's group: its album tag, without case, in its album's folder. */
export function albumKey(track: Pick<Track, "metadata" | "relativePath">): string {
  return `@album:${albumFolder(track)}::${track.metadata.album.trim().toLowerCase()}`;
}

function grouped(tracks: readonly Track[], keyOf: (track: Track) => string, labelOf: (track: Track) => string, metaOf: (tracks: Track[]) => string, locale: string): Group[] {
  const groups = new Map<string, Track[]>();
  for (const track of tracks) {
    const key = keyOf(track);
    const members = groups.get(key);
    if (members) members.push(track);
    else groups.set(key, [track]);
  }
  return [...groups.entries()]
    .map(([key, members]) => {
      const label = labelOf(members[0]);
      return { key, label: label || "", meta: metaOf(members), tracks: orderDetailPlaylist(members), known: !!label };
    })
    .sort((left, right) => Number(right.known) - Number(left.known) || compareText(left.label, right.label, locale));
}

const artistsOf = (tracks: readonly Track[], labels: ViewLabels): Group[] =>
  grouped(tracks, artistKey, (track) => track.metadata.artist.trim(), () => "", labels.locale).map((group) => ({
    ...group,
    label: group.label || labels.unknownArtist
  }));

/** How many artists an album's tracks have (without case). */
const artistCount = (tracks: readonly Track[]): number => new Set(tracks.map((track) => track.metadata.artist.trim().toLowerCase())).size;

/** Whether an album is a compilation: a track marked so, or tracks by more than one artist with no album artist to join them. */
const isCompilationAlbum = (tracks: readonly Track[]): boolean =>
  tracks.some((track) => isCompilation(track.metadata)) || (artistCount(tracks) > 1 && !tracks.some((track) => track.metadata.albumArtist.trim()));

/**
 * Who an album is by: its album artist; "Various artists" for a compilation without one; else its
 * tracks' artist. Empty when unknown.
 */
export function albumArtistOf(tracks: readonly Track[], variousArtists: string): string {
  const tagged = tracks.find((track) => track.metadata.albumArtist.trim())?.metadata.albumArtist.trim();
  if (tagged) return tagged;
  return isCompilationAlbum(tracks) ? variousArtists : (tracks[0]?.metadata.artist.trim() ?? "");
}

const albumsOf = (tracks: readonly Track[], labels: ViewLabels): Group[] =>
  grouped(
    tracks,
    albumKey,
    (track) => track.metadata.album.trim(),
    (members) => albumArtistOf(members, labels.variousArtists) || labels.unknownArtist,
    labels.locale
  ).map((group) => ({ ...group, label: group.label || labels.unknownAlbum }));

/**
 * The artists of the albums, for Albums by artist: each album under who it is by (its album
 * artist, or "Various artists" for a compilation), so a compilation's tracks stay together.
 */
const albumArtistsOf = (tracks: readonly Track[], labels: ViewLabels): Group[] => {
  const byAlbum = new Map<string, Track[]>();
  for (const track of tracks) {
    const key = albumKey(track);
    const members = byAlbum.get(key);
    if (members) members.push(track);
    else byAlbum.set(key, [track]);
  }
  const artistOfAlbum = new Map([...byAlbum.entries()].map(([key, members]) => [key, albumArtistOf(members, labels.variousArtists)]));
  const artistOf = (track: Track): string => artistOfAlbum.get(albumKey(track)) ?? "";
  return grouped(tracks, (track) => `@artist:${artistOf(track).toLowerCase()}`, artistOf, () => "", labels.locale).map((group) => ({
    ...group,
    label: group.label || labels.unknownArtist
  }));
};

/** The cover an album's tracks show: the first one's that has one. */
export function coverOfTracks(tracks: readonly Pick<Track, "metadata">[]): string | undefined {
  return tracks.find((track) => track.metadata.coverDataUrl)?.metadata.coverDataUrl ?? undefined;
}

/** An album's year: its first track's that has one, as four digits when the tag is a date. */
export function yearOfTracks(tracks: readonly Pick<Track, "metadata">[]): string {
  const year = tracks.find((track) => track.metadata.year.trim())?.metadata.year.trim() ?? "";
  return /^\d{4}/.test(year) ? year.slice(0, 4) : year;
}

/**
 * The rows of `view` (not Files) for a root's `tracks`: a group's tracks
 * only when its key is in `expanded` (or `"all"`). `playlists` are the
 * root's, for the Playlists view.
 */
export function buildViewRows(
  view: Exclude<LibraryView, "files">,
  tracks: readonly Track[],
  expanded: readonly string[] | "all",
  labels: ViewLabels,
  playlists: readonly Playlist[] = [],
  artistPictures: Readonly<Record<string, string>> = {}
): WizardTreeRow[] {
  const open = (key: string): boolean => expanded === "all" || expanded.includes(key);
  const rows: WizardTreeRow[] = [];
  // An album's row: its cover, and under its name who it is by (Albums, `by`) or its year (Albums
  // by artist, where its artist is the row above it).
  // Every album row has a cover's room, so their names line up whether they have one or not.
  const albumExtras = (group: Group, by: boolean): Pick<WizardTreeRow, "cover" | "sub" | "framed"> => {
    const cover = coverOfTracks(group.tracks);
    const sub = by ? group.meta : yearOfTracks(group.tracks);
    return { framed: true, ...(cover ? { cover } : {}), ...(sub ? { sub } : {}) };
  };
  // An artist's row, round: their picture, else the cover of the first of their albums that has
  // one; every artist row with its room, so their names line up.
  const artistExtras = (group: Group): Pick<WizardTreeRow, "cover" | "framed" | "round"> => {
    const name = artistOfKey(group.key);
    const cover = (name === null ? undefined : artistPictures[name]) ?? coverOfTracks(group.tracks);
    return { framed: true, round: true, ...(cover ? { cover } : {}) };
  };
  // "Artist - Album": the line under a song's title, so two songs of one title tell themselves apart.
  const byWhom = (track: Track): string => [track.metadata.artist.trim(), track.metadata.album.trim()].filter(Boolean).join(" - ");
  const groupRow = (group: Group, parentKey: string | null, depth: number, extras: Pick<WizardTreeRow, "cover" | "sub" | "framed" | "round"> = {}): boolean => {
    const isOpen = open(group.key);
    rows.push({
      ...extras,
      key: group.key,
      kind: "album",
      album: group.key,
      label: group.label,
      meta: group.meta,
      expanded: isOpen,
      parentKey,
      depth,
      trackIds: group.tracks.map((track) => track.id),
      inView: view
    });
    return isOpen;
  };
  // A track's row: its title; `extras` its line under it and, in Songs, its album's cover.
  const trackRow = (track: Track, parentKey: string | null, depth: number, meta: string, extras: Pick<WizardTreeRow, "cover" | "sub" | "framed"> = {}): void => {
    rows.push({
      ...extras,
      key: `track:${track.id}`,
      kind: "track",
      album: "",
      label: track.metadata.title || track.name,
      trackId: track.id,
      trackNumber: track.metadata.trackNumber,
      artist: track.metadata.artist,
      relativePath: track.relativePath,
      format: codecLabel(track.relativePath, track.audio),
      ...(track.pending ? { pending: true } : {}),
      meta,
      parentKey,
      depth,
      inView: view
    });
  };

  if (view === "songs") {
    const byTitle = [...tracks].sort(
      (left, right) => compareText(left.metadata.title || left.name, right.metadata.title || right.name, labels.locale) || left.relativePath.localeCompare(right.relativePath)
    );
    // Each song with its album's cover and, under its title, who and which album.
    for (const track of byTitle) {
      const cover = track.metadata.coverDataUrl;
      const sub = byWhom(track);
      trackRow(track, null, 0, sub, { framed: true, ...(cover ? { cover } : {}), ...(sub ? { sub } : {}) });
    }
  } else if (view === "artists") {
    for (const artist of artistsOf(tracks, labels)) {
      if (groupRow(artist, null, 0, artistExtras(artist))) {
        for (const track of artist.tracks) {
          const sub = byWhom(track);
          trackRow(track, artist.key, 1, track.metadata.album, sub ? { sub } : {});
        }
      }
    }
  } else if (view === "albumsByArtist") {
    for (const artist of albumArtistsOf(tracks, labels)) {
      if (!groupRow(artist, null, 0, artistExtras(artist))) continue;
      for (const album of albumsOf(artist.tracks, labels)) {
        const sub = { ...album, key: `@aba:${artist.key.slice(8)}::${album.key.slice(7)}`, meta: "" };
        if (groupRow(sub, artist.key, 1, albumExtras(sub, false))) {
          for (const track of album.tracks) trackRow(track, sub.key, 2, track.metadata.artist);
        }
      }
    }
  } else if (view === "albums" || view === "compilations") {
    const albums = albumsOf(tracks, labels).filter((album) => view === "albums" || isCompilationAlbum(album.tracks));
    for (const album of albums) {
      if (groupRow(album, null, 0, albumExtras(album, true))) {
        for (const track of album.tracks) trackRow(track, album.key, 1, track.metadata.artist);
      }
    }
  } else if (view === "playlists") {
    const byPath = new Map(tracks.map((track) => [track.relativePath, track]));
    const sorted = [...playlists].sort((left, right) => compareText(left.name, right.name, labels.locale));
    for (const playlist of sorted) {
      const key = `@playlist:${playlist.path}`;
      const found = playlist.entries.map((entry) => (entry.path ? byPath.get(entry.path) : undefined));
      const isOpen = open(key);
      rows.push({
        key,
        kind: "album",
        album: key,
        label: playlist.name,
        meta: String(playlist.entries.length),
        expanded: isOpen,
        parentKey: null,
        depth: 0,
        trackIds: found.flatMap((track) => (track ? [track.id] : [])),
        inView: view,
        playlist: playlist.path
      });
      if (!isOpen) continue;
      playlist.entries.forEach((entry, index) => {
        const track = found[index];
        const base = { key: `@pl:${playlist.path}#${index}`, kind: "track" as const, album: "", parentKey: key, depth: 1, inView: view, playlist: playlist.path, playlistIndex: index };
        if (track) {
          rows.push({ ...base, label: track.metadata.title || track.name, trackId: track.id, trackNumber: track.metadata.trackNumber, artist: track.metadata.artist, relativePath: track.relativePath, format: codecLabel(track.relativePath, track.audio), meta: track.metadata.artist, ...(track.metadata.artist ? { sub: track.metadata.artist } : {}) });
        } else {
          rows.push({ ...base, label: entry.title || entry.raw.split(/[\\/]/).pop() || entry.raw, meta: labels.missing, missing: true });
        }
      });
    }
  }
  return rows;
}

/**
 * Where a track is in a list of rows drawn all open: its row's key, and the keys that open the rows
 * above it (their `album`, from the outermost); null when the list has no row of it (a playlist's
 * entries are rows of their own).
 */
export function trackPlace(rows: readonly WizardTreeRow[], trackId: string): { key: string; open: string[] } | null {
  const key = `track:${trackId}`;
  const byKey = new Map(rows.map((row) => [row.key, row]));
  const row = byKey.get(key);
  if (!row) return null;
  const open: string[] = [];
  for (let parent = row.parentKey ? byKey.get(row.parentKey) : undefined; parent; parent = parent.parentKey ? byKey.get(parent.parentKey) : undefined) {
    open.unshift(parent.album);
  }
  return { key, open };
}
