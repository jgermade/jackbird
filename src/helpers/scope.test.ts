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

describe("detailScope in the views", () => {
  const a = track("A/1.mp3", { title: "One" });
  const b = track("B/2.mp3", { title: "Two" });
  const root = (activeRowKey: string | null) => ({ label: "Music", tracks: [a, b], activeRowKey });
  const rows = [
    { key: "@artist:x", kind: "album" as const, album: "@artist:x", label: "X", parentKey: null, depth: 0, trackIds: [b.id, a.id], inView: "artists" as const },
    { key: "track:B/2.mp3", kind: "track" as const, album: "", label: "Two", parentKey: "@artist:x", depth: 1, trackId: b.id, inView: "artists" as const },
    { key: "track:A/1.mp3", kind: "track" as const, album: "", label: "One", parentKey: null, depth: 0, trackId: a.id, inView: "songs" as const }
  ];

  it("shows a group's tracks in its order", () => {
    assert.deepEqual(detailScope(root("@artist:x"), rows), { label: "X", tracks: [b, a], ordered: true });
  });

  it("shows a track's group", () => {
    assert.deepEqual(detailScope(root("track:B/2.mp3"), rows), { label: "X", tracks: [b, a], ordered: true });
  });

  it("shows the view's tracks for a track without a group", () => {
    assert.deepEqual(detailScope(root("track:A/1.mp3"), rows), { label: "Music", tracks: [b, a], ordered: true });
  });
});
