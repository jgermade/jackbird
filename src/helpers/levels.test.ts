import assert from "node:assert/strict";
import { test } from "node:test";
import type { WizardTreeRow } from "../types.ts";
import { levelsOf, openOnEntering, openOnLeaving } from "./levels.ts";

const folder = (album: string, parentKey: string | null, depth: number, expanded = false): WizardTreeRow => ({
  key: `folder:${album}`,
  kind: "album",
  album,
  label: album.split("/").pop() ?? album,
  parentKey,
  depth,
  expanded
});
const track = (id: string, parentKey: string | null, depth: number): WizardTreeRow => ({
  key: `track:${id}`,
  kind: "track",
  album: "",
  label: id,
  trackId: id,
  parentKey,
  depth
});

// Jazz (open) > Miles (open) > two tracks; Jazz > Monk (closed); Rock (closed); a loose track.
const rows: WizardTreeRow[] = [
  folder("Jazz", null, 0, true),
  folder("Jazz/Miles", "folder:Jazz", 1, true),
  track("so-what", "folder:Jazz/Miles", 2),
  track("blue-in-green", "folder:Jazz/Miles", 2),
  folder("Jazz/Monk", "folder:Jazz", 1),
  track("jazz-intro", "folder:Jazz", 1),
  folder("Rock", null, 0),
  track("loose", null, 0)
];
const keys = (list: WizardTreeRow[]): string[] => list.map((row) => row.key);

test("with nothing open the levels are the top of the list", () => {
  const closed = [folder("Jazz", null, 0), folder("Rock", null, 0), track("loose", null, 0)];
  const levels = levelsOf(closed);
  assert.deepEqual(levels.open, []);
  assert.deepEqual(keys(levels.rows), ["folder:Jazz", "folder:Rock", "track:loose"]);
  assert.deepEqual(levelsOf([]), { open: [], rows: [] });
});

test("the open folders stack from the top down, and the list is what the last one holds", () => {
  const levels = levelsOf(rows);
  assert.deepEqual(keys(levels.open), ["folder:Jazz", "folder:Jazz/Miles"]);
  assert.deepEqual(keys(levels.rows), ["track:so-what", "track:blue-in-green"]);
});

test("one level open lists its folders and its tracks, not its neighbours", () => {
  const one = rows.map((row) => (row.key === "folder:Jazz/Miles" ? { ...row, expanded: false } : row)).filter((row) => row.parentKey !== "folder:Jazz/Miles");
  const levels = levelsOf(one);
  assert.deepEqual(keys(levels.open), ["folder:Jazz"]);
  assert.deepEqual(keys(levels.rows), ["folder:Jazz/Miles", "folder:Jazz/Monk", "track:jazz-intro"]);
});

test("two folders open at one level: the first is the one followed", () => {
  const both = [folder("Jazz", null, 0, true), track("a", "folder:Jazz", 1), folder("Rock", null, 0, true), track("b", "folder:Rock", 1)];
  assert.deepEqual(keys(levelsOf(both).open), ["folder:Jazz"]);
  assert.deepEqual(keys(levelsOf(both).rows), ["track:a"]);
});

test("entering a folder opens it and the ones above it, and closes the others shown", () => {
  // Monk, beside the open Miles: Miles closes, Jazz stays.
  assert.deepEqual(openOnEntering(rows, ["Jazz", "Jazz/Miles"], "folder:Jazz/Monk"), ["Jazz", "Jazz/Monk"]);
  // Rock, at the top: Jazz and what it had open close.
  assert.deepEqual(openOnEntering(rows, ["Jazz", "Jazz/Miles"], "folder:Rock"), ["Rock"]);
  // Open already: nothing changes.
  assert.deepEqual(openOnEntering(rows, ["Jazz", "Jazz/Miles"], "folder:Jazz/Miles"), ["Jazz", "Jazz/Miles"]);
});

test("what the list does not show stays open or closed as it was", () => {
  // Another view's group, kept in the same list of open ones.
  assert.deepEqual(openOnEntering(rows, ["artist:Miles Davis", "Jazz"], "folder:Rock"), ["artist:Miles Davis", "Rock"]);
  assert.deepEqual(openOnLeaving(rows, ["artist:Miles Davis", "Jazz", "Jazz/Miles"], "folder:Jazz"), ["artist:Miles Davis"]);
});

test("leaving an open folder closes it and the ones under it", () => {
  assert.deepEqual(openOnLeaving(rows, ["Jazz", "Jazz/Miles"], "folder:Jazz/Miles"), ["Jazz"]);
  assert.deepEqual(openOnLeaving(rows, ["Jazz", "Jazz/Miles"], "folder:Jazz"), []);
});

test("a track's row, or an unknown one, opens only the folders above it", () => {
  assert.deepEqual(openOnEntering(rows, ["Jazz", "Jazz/Miles"], "track:jazz-intro"), ["Jazz"]);
  assert.deepEqual(openOnEntering(rows, ["Jazz"], "folder:Nowhere"), []);
});
