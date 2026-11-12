import type { Track, WizardTreeRow } from "../types.ts";

/** What the album sheet shows: a label and the tracks under it. */
export type Scope = {
  label: string;
  tracks: Track[];
  /** Whether `tracks` are in the order to play (a view's group, a playlist), not to be sorted by folder and number. */
  ordered?: boolean;
  /** Whether it is the whole root: its label is then the root's, which its tab already shows. */
  whole?: boolean;
};

type ScopedRoot = {
  label: string;
  tracks: Track[];
  activeRowKey: string | null;
};

/**
 * The album sheet's scope. A folder row shows the tracks under that folder,
 * labelled with its name; a track row shows its folder, labelled with the
 * folder's path; anything else (no row, a row not shown, a track at the top)
 * shows the whole root. In the other views, a group shows its tracks, in its
 * order; a track shows its group's; a track with no group (Songs) shows the
 * view's tracks, in its order.
 */
export function detailScope(root: ScopedRoot | null, rows: readonly WizardTreeRow[]): Scope {
  if (!root) {
    return { label: "", tracks: [] };
  }
  const row = root.activeRowKey ? rows.find((candidate) => candidate.key === root.activeRowKey) : undefined;
  if (row?.inView) {
    const byId = new Map(root.tracks.map((track) => [track.id, track]));
    const tracksOf = (ids: readonly string[]): Track[] => ids.flatMap((id) => byId.get(id) ?? []);
    const group = row.trackIds ? row : rows.find((candidate) => candidate.key === row.parentKey);
    if (group?.trackIds) {
      return { label: group.label, tracks: tracksOf(group.trackIds), ordered: true };
    }
    return { label: root.label, tracks: tracksOf(rows.flatMap((candidate) => (candidate.trackId ? [candidate.trackId] : []))), ordered: true, whole: true };
  }
  if (row && (row.kind === "album" || (row.kind === "track" && row.album))) {
    const prefix = `${row.album}/`;
    return {
      label: row.kind === "album" ? row.label : row.album,
      tracks: root.tracks.filter((track) => track.relativePath.startsWith(prefix))
    };
  }
  return { label: root.label, tracks: root.tracks, whole: true };
}
