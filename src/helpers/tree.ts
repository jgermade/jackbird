import type { Mp3Track, WizardTreeRow } from "../types.ts";

type FolderNode = {
  folders: Map<string, FolderNode>;
  tracks: Mp3Track[];
};

/**
 * The library tree as flat rows, in display order: each folder, sorted by
 * name, then the tracks directly in it, sorted by path. A folder's content
 * only appears when its path is in `expandedFolders`. A track is labelled
 * by its title, or by its file name when it has none.
 */
export function buildWizardRows(tracks: Mp3Track[], expandedFolders: readonly string[]): WizardTreeRow[] {
  const root: FolderNode = { folders: new Map(), tracks: [] };
  for (const track of tracks) {
    let node = root;
    for (const folder of track.relativePath.split("/").slice(0, -1)) {
      let child = node.folders.get(folder);
      if (!child) {
        child = { folders: new Map(), tracks: [] };
        node.folders.set(folder, child);
      }
      node = child;
    }
    node.tracks.push(track);
  }

  const expanded = new Set(expandedFolders);
  const rows: WizardTreeRow[] = [];

  const append = (node: FolderNode, parentPath: string, parentKey: string | null, depth: number): void => {
    const folders = [...node.folders.entries()].sort(([left], [right]) => left.localeCompare(right, "es"));
    for (const [folder, child] of folders) {
      const folderPath = parentPath ? `${parentPath}/${folder}` : folder;
      const folderKey = `folder:${folderPath}`;
      const isExpanded = expanded.has(folderPath);
      rows.push({ key: folderKey, kind: "album", album: folderPath, label: folder, expanded: isExpanded, parentKey, depth });
      if (isExpanded) {
        append(child, folderPath, folderKey, depth + 1);
      }
    }

    const files = [...node.tracks].sort((left, right) => left.relativePath.localeCompare(right.relativePath, "es"));
    for (const track of files) {
      rows.push({
        key: `track:${track.id}`,
        kind: "track",
        album: parentPath,
        label: track.metadata.title || track.name,
        trackId: track.id,
        trackNumber: track.metadata.trackNumber,
        artist: track.metadata.artist,
        relativePath: track.relativePath,
        parentKey,
        depth
      });
    }
  };

  append(root, "", null, 0);
  return rows;
}
