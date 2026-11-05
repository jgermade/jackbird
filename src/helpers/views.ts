/**
 * The library's views other than Files, as the same flat rows the tree
 * draws: groups (artists, albums, playlists) that open into their tracks,
 * or a flat list (Songs). A group row carries its tracks' ids in the order
 * they play, and its key is also what opens and closes it (kept in the
 * root's `expandedAlbums`, beside the folders' paths). See
 * RECORD/2026-11-04.github-actions-workflows.WIP.md (22:00 and W6's plan).
 */

import type { LibraryView, Mp3Track, Playlist, WizardTreeRow } from "../types.ts";
import { orderDetailPlaylist } from "./tracks.ts";

/** The words and the order a view needs. */
export type ViewLabels = {
  unknownArtist: string;
  unknownAlbum: string;
  variousArtists: string;
  missing: string;
  locale: string;
};

type Group = { key: string; label: string; meta: string; tracks: Mp3Track[]; known: boolean };

const DISC_FOLDER = /^(?:cd|disc)[ _-]?\d+$/i;

/** The folder an album is in: a track's folder, its parent when that is a "Disc N" or "CD N" one. */
export function albumFolder(track: Pick<Mp3Track, "relativePath">): string {
  const folders = track.relativePath.split("/").slice(0, -1);
  if (folders.length > 0 && DISC_FOLDER.test(folders[folders.length - 1])) {
    folders.pop();
  }
  return folders.join("/");
}

/** The key of a track's artist's group. */
export function artistKey(track: Pick<Mp3Track, "metadata">): string {
  return `@artist:${track.metadata.artist.trim().toLowerCase()}`;
}

/** The key of a track's album's group: its album tag, without case, in its album's folder. */
export function albumKey(track: Pick<Mp3Track, "metadata" | "relativePath">): string {
  return `@album:${albumFolder(track)}::${track.metadata.album.trim().toLowerCase()}`;
}

function grouped(tracks: readonly Mp3Track[], keyOf: (track: Mp3Track) => string, labelOf: (track: Mp3Track) => string, metaOf: (tracks: Mp3Track[]) => string, locale: string): Group[] {
  const groups = new Map<string, Mp3Track[]>();
  for (const track of tracks) {
    const key = keyOf(track);
    groups.set(key, [...(groups.get(key) ?? []), track]);
  }
  return [...groups.entries()]
    .map(([key, members]) => {
      const label = labelOf(members[0]);
      return { key, label: label || "", meta: metaOf(members), tracks: orderDetailPlaylist(members), known: !!label };
    })
    .sort((left, right) => Number(right.known) - Number(left.known) || left.label.localeCompare(right.label, locale));
}

const artistsOf = (tracks: readonly Mp3Track[], labels: ViewLabels): Group[] =>
  grouped(tracks, artistKey, (track) => track.metadata.artist.trim(), () => "", labels.locale).map((group) => ({
    ...group,
    label: group.label || labels.unknownArtist
  }));

/** How many artists an album's tracks have (without case). */
const artistCount = (tracks: readonly Mp3Track[]): number => new Set(tracks.map((track) => track.metadata.artist.trim().toLowerCase())).size;

const albumsOf = (tracks: readonly Mp3Track[], labels: ViewLabels): Group[] =>
  grouped(
    tracks,
    albumKey,
    (track) => track.metadata.album.trim(),
    (members) => (artistCount(members) > 1 ? labels.variousArtists : members[0].metadata.artist.trim() || labels.unknownArtist),
    labels.locale
  ).map((group) => ({ ...group, label: group.label || labels.unknownAlbum }));

/**
 * The rows of `view` (not Files) for a root's `tracks`: a group's tracks
 * only when its key is in `expanded` (or `"all"`). `playlists` are the
 * root's, for the Playlists view.
 */
export function buildViewRows(
  view: Exclude<LibraryView, "files">,
  tracks: readonly Mp3Track[],
  expanded: readonly string[] | "all",
  labels: ViewLabels,
  playlists: readonly Playlist[] = []
): WizardTreeRow[] {
  const open = (key: string): boolean => expanded === "all" || expanded.includes(key);
  const rows: WizardTreeRow[] = [];
  const groupRow = (group: Group, parentKey: string | null, depth: number): boolean => {
    const isOpen = open(group.key);
    rows.push({
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
  const trackRow = (track: Mp3Track, parentKey: string | null, depth: number, meta: string): void => {
    rows.push({
      key: `track:${track.id}`,
      kind: "track",
      album: "",
      label: track.metadata.title || track.name,
      trackId: track.id,
      trackNumber: track.metadata.trackNumber,
      artist: track.metadata.artist,
      relativePath: track.relativePath,
      meta,
      parentKey,
      depth,
      inView: view
    });
  };

  if (view === "songs") {
    const byTitle = [...tracks].sort(
      (left, right) => (left.metadata.title || left.name).localeCompare(right.metadata.title || right.name, labels.locale) || left.relativePath.localeCompare(right.relativePath)
    );
    for (const track of byTitle) trackRow(track, null, 0, track.metadata.artist);
  } else if (view === "artists") {
    for (const artist of artistsOf(tracks, labels)) {
      if (groupRow(artist, null, 0)) {
        for (const track of artist.tracks) trackRow(track, artist.key, 1, track.metadata.album);
      }
    }
  } else if (view === "albumsByArtist") {
    for (const artist of artistsOf(tracks, labels)) {
      if (!groupRow(artist, null, 0)) continue;
      for (const album of albumsOf(artist.tracks, labels)) {
        const sub = { ...album, key: `@aba:${artist.key.slice(8)}::${album.key.slice(7)}`, meta: "" };
        if (groupRow(sub, artist.key, 1)) {
          for (const track of album.tracks) trackRow(track, sub.key, 2, track.metadata.artist);
        }
      }
    }
  } else if (view === "albums" || view === "compilations") {
    const albums = albumsOf(tracks, labels).filter((album) => view === "albums" || artistCount(album.tracks) > 1);
    for (const album of albums) {
      if (groupRow(album, null, 0)) {
        for (const track of album.tracks) trackRow(track, album.key, 1, track.metadata.artist);
      }
    }
  } else if (view === "playlists") {
    const byPath = new Map(tracks.map((track) => [track.relativePath, track]));
    const sorted = [...playlists].sort((left, right) => left.name.localeCompare(right.name, labels.locale));
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
          rows.push({ ...base, label: track.metadata.title || track.name, trackId: track.id, trackNumber: track.metadata.trackNumber, artist: track.metadata.artist, relativePath: track.relativePath, meta: track.metadata.artist });
        } else {
          rows.push({ ...base, label: entry.title || entry.raw.split(/[\\/]/).pop() || entry.raw, meta: labels.missing, missing: true });
        }
      });
    }
  }
  return rows;
}
