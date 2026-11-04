import type { Mp3Track, WizardTreeRow } from "../types.ts";

/** What the album sheet shows: a label and the tracks under it. */
export type Scope = {
  label: string;
  tracks: Mp3Track[];
};

type ScopedRoot = {
  label: string;
  tracks: Mp3Track[];
  activeRowKey: string | null;
};

/**
 * The album sheet's scope. A folder row shows the tracks under that folder,
 * labelled with its name; a track row shows its folder, labelled with the
 * folder's path; anything else (no row, a row not shown, a track at the top)
 * shows the whole root.
 */
export function detailScope(root: ScopedRoot | null, rows: readonly WizardTreeRow[]): Scope {
  if (!root) {
    return { label: "", tracks: [] };
  }
  const row = root.activeRowKey ? rows.find((candidate) => candidate.key === root.activeRowKey) : undefined;
  if (row && (row.kind === "album" || (row.kind === "track" && row.album))) {
    const prefix = `${row.album}/`;
    return {
      label: row.kind === "album" ? row.label : row.album,
      tracks: root.tracks.filter((track) => track.relativePath.startsWith(prefix))
    };
  }
  return { label: root.label, tracks: root.tracks };
}
