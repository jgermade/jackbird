import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { track } from "./fixtures.test-support.ts";
import { detailScope } from "./scope.ts";
import { buildWizardRows } from "./tree.ts";

const tracks = [track("Jazz/Miles/01.mp3", {}, "t1"), track("Jazz/Miles/02.mp3", {}, "t2"), track("Jazz/Bill/01.mp3", {}, "t3"), track("loose.mp3", {}, "t4")];
const rows = buildWizardRows(tracks, ["Jazz", "Jazz/Miles"]);
const root = (activeRowKey: string | null) => ({ label: "Music", tracks, activeRowKey });
const ids = (scope: { tracks: { id: string }[] }) => scope.tracks.map((one) => one.id);

describe("detailScope", () => {
  it("is empty without a root", () => {
    assert.deepEqual(detailScope(null, rows), { label: "", tracks: [] });
  });

  it("is the whole root without an active row, or with one not shown", () => {
    assert.equal(detailScope(root(null), rows).label, "Music");
    assert.deepEqual(ids(detailScope(root(null), rows)), ["t1", "t2", "t3", "t4"]);
    assert.deepEqual(ids(detailScope(root("folder:Gone"), rows)), ["t1", "t2", "t3", "t4"]);
  });

  it("is a folder's tracks, at any depth, under the folder's name", () => {
    assert.deepEqual(detailScope(root("folder:Jazz"), rows), { label: "Jazz", tracks: tracks.slice(0, 3) });
    assert.deepEqual(detailScope(root("folder:Jazz/Miles"), rows), { label: "Miles", tracks: tracks.slice(0, 2) });
  });

  it("is a track's folder, under the folder's path", () => {
    assert.deepEqual(detailScope(root("track:t2"), rows), { label: "Jazz/Miles", tracks: tracks.slice(0, 2) });
  });

  it("is the whole root for a track at the top", () => {
    assert.equal(detailScope(root("track:t4"), rows).label, "Music");
  });
});
