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
  /** How the library lists it (Files when not given). */
  view?: string;
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

/** One step of the album sheet's breadcrumb: a row of the library to go back to, or the root's top (`key` null). */
export type Crumb = { key: string | null; label: string };

/**
 * Where the album sheet's scope comes from, as a breadcrumb: in Files, the root and then each folder
 * down to the one shown (a track's folder for a track); in the other views, each group down to the
 * one shown (an artist, then their album). Nothing for a view's whole list. The sheet puts the
 * view's glyph before it. See RECORD/2026-11-03.deck-design-system.WIP.md (2026-11-13 16:45).
 */
export function scopeCrumbs(root: ScopedRoot | null, rows: readonly WizardTreeRow[]): Crumb[] {
  if (!root) return [];
  const byKey = new Map(rows.map((row) => [row.key, row]));
  const row = root.activeRowKey ? byKey.get(root.activeRowKey) : undefined;
  const top: Crumb[] = root.view && root.view !== "files" ? [] : [{ key: null, label: root.label }];
  if (!row) return top;
  // The row the scope is: a group or folder itself, or a track's group or folder.
  const shown = row.kind === "album" ? row : row.parentKey ? byKey.get(row.parentKey) : undefined;
  if (!shown || shown.kind !== "album" || (row.inView && !shown.trackIds)) return top;
  const chain: Crumb[] = [];
  for (let step: WizardTreeRow | undefined = shown; step; step = step.parentKey ? byKey.get(step.parentKey) : undefined) {
    if (step.kind === "album") chain.unshift({ key: step.key, label: step.label });
  }
  return [...top, ...chain];
}
