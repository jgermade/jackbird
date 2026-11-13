// The library's tree without its songs (a preference: Settings, "Songs in the library"): its
// folders and groups only, a song reached through Details. Each row says whether it is a leaf,
// a folder or group that holds no other (a folder with no subfolder, an album, a playlist), which a
// phone opens in Details instead of entering. See RECORD/2026-11-03.deck-design-system.WIP.md
// (2026-11-13 19:35 UTC, "Next: the library without its songs").

import type { LibraryView, Track, WizardTreeRow } from "../types.ts";

/** The folders that hold another folder, by path, from the tracks' paths. */
export function foldersWithSubfolders(tracks: readonly Pick<Track, "relativePath">[]): Set<string> {
  const parents = new Set<string>();
  for (const track of tracks) {
    const folders = track.relativePath.split("/").slice(0, -1);
    for (let depth = 1; depth < folders.length; depth += 1) parents.add(folders.slice(0, depth).join("/"));
  }
  return parents;
}

/**
 * `rows` without their songs (and their discs, which only hold songs), each folder or group marked
 * a leaf or not, a leaf closed. The Songs view is its songs: as it is.
 */
export function withoutSongs(rows: readonly WizardTreeRow[], view: LibraryView, tracks: readonly Pick<Track, "relativePath">[]): WizardTreeRow[] {
  if (view === "songs") return [...rows];
  const parents = view === "files" ? foldersWithSubfolders(tracks) : null;
  return rows
    .filter((row) => row.kind === "album")
    .map((row) => {
      // Files: a folder with none under it; Album artists: an album (an artist holds albums); elsewhere every group.
      const leaf = parents ? !parents.has(row.album) : view === "albumsByArtist" ? row.depth > 0 : true;
      return leaf ? { ...row, leaf, expanded: false } : { ...row, leaf };
    });
}
