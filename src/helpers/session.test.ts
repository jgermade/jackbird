import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parsePlaybackState, parseViewState, sameSession, sessionOf } from "./session.ts";

const music = { name: "Music" };
const podcasts = { name: "Podcasts" };
const open = [
  { id: "1", label: "Music", rootHandle: music, groupingMode: "wizard" as const, tracks: [], expandedAlbums: ["Jazz", "Jazz/Miles"], activeRowKey: "folder:Jazz/Miles" },
  { id: "2", label: "Podcasts", rootHandle: podcasts, groupingMode: "flat" as const, tracks: [], expandedAlbums: [], activeRowKey: null }
];

describe("sessionOf", () => {
  it("keeps each root's id, label, handle, grouping, open folders and current row, in order, and the active id", () => {
    assert.deepEqual(sessionOf(open, "2"), {
      roots: [
        { id: "1", label: "Music", handle: music, groupingMode: "wizard", expandedAlbums: ["Jazz", "Jazz/Miles"], activeRowKey: "folder:Jazz/Miles" },
        { id: "2", label: "Podcasts", handle: podcasts, groupingMode: "flat", expandedAlbums: [], activeRowKey: null }
      ],
      activeRootId: "2"
    });
  });

  it("is empty with no roots open", () => {
    assert.deepEqual(sessionOf([], null), { roots: [], activeRootId: null });
  });
});

describe("sameSession", () => {
  const saved = sessionOf(open, "1");

  it("differs from nothing saved", () => {
    assert.equal(sameSession(null, saved), false);
  });

  it("is the same for the same roots, whatever else changed in them", () => {
    assert.equal(sameSession(saved, sessionOf(open.map((root) => ({ ...root, tracks: [] })), "1")), true);
  });

  it("differs when the active root changes", () => {
    assert.equal(sameSession(saved, sessionOf(open, "2")), false);
  });

  it("differs when a root opens or closes", () => {
    assert.equal(sameSession(saved, sessionOf(open.slice(0, 1), "1")), false);
  });

  it("differs when the order, a label, a handle or the grouping changes", () => {
    assert.equal(sameSession(saved, sessionOf([open[1], open[0]], "1")), false);
    assert.equal(sameSession(saved, sessionOf([{ ...open[0], label: "Música" }, open[1]], "1")), false);
    assert.equal(sameSession(saved, sessionOf([{ ...open[0], rootHandle: { name: "Music" } }, open[1]], "1")), false);
    assert.equal(sameSession(saved, sessionOf([open[0], { ...open[1], groupingMode: "wizard" as const }], "1")), false);
  });

  it("differs when a root's open folders or current row change", () => {
    assert.equal(sameSession(saved, sessionOf([{ ...open[0], expandedAlbums: ["Jazz"] }, open[1]], "1")), false);
    assert.equal(sameSession(saved, sessionOf([{ ...open[0], expandedAlbums: ["Jazz", "Rock"] }, open[1]], "1")), false);
    assert.equal(sameSession(saved, sessionOf([{ ...open[0], activeRowKey: "track:t1" }, open[1]], "1")), false);
  });

  it("reads a session saved before folders and rows were kept as having none", () => {
    const old = { roots: [{ id: "2", label: "Podcasts", handle: podcasts, groupingMode: "flat" as const }], activeRootId: "2" };
    assert.equal(sameSession(old, sessionOf([open[1]], "2")), true);
  });
});

describe("parsePlaybackState", () => {
  const saved = { queue: { rootId: "1", trackIds: ["a.mp3", "b.mp3"], sourceLabel: "Jazz" }, index: 1, position: 12.5, playing: true };

  it("reads what was saved", () => {
    assert.deepEqual(parsePlaybackState(JSON.stringify(saved)), saved);
  });

  it("is null for nothing, broken JSON, or something that is not a saved playback", () => {
    assert.equal(parsePlaybackState(null), null);
    assert.equal(parsePlaybackState(""), null);
    assert.equal(parsePlaybackState("{"), null);
    assert.equal(parsePlaybackState("[]"), null);
    assert.equal(parsePlaybackState(JSON.stringify({ ...saved, queue: null })), null);
    assert.equal(parsePlaybackState(JSON.stringify({ ...saved, queue: { ...saved.queue, trackIds: [] } })), null);
    assert.equal(parsePlaybackState(JSON.stringify({ ...saved, queue: { ...saved.queue, trackIds: [1] } })), null);
    assert.equal(parsePlaybackState(JSON.stringify({ ...saved, queue: { ...saved.queue, rootId: 1 } })), null);
    assert.equal(parsePlaybackState(JSON.stringify({ ...saved, index: 2 })), null);
    assert.equal(parsePlaybackState(JSON.stringify({ ...saved, index: -1 })), null);
    assert.equal(parsePlaybackState(JSON.stringify({ ...saved, index: 0.5 })), null);
    assert.equal(parsePlaybackState(JSON.stringify({ ...saved, position: -1 })), null);
    assert.equal(parsePlaybackState(JSON.stringify({ ...saved, position: "12" })), null);
    assert.equal(parsePlaybackState(JSON.stringify({ ...saved, playing: "yes" })), null);
  });
});

describe("parseViewState", () => {
  it("reads the panel and the scroll positions", () => {
    assert.deepEqual(parseViewState(JSON.stringify({ panel: "details", treeScroll: 120, sheetScroll: 40.5 })), { panel: "details", treeScroll: 120, sheetScroll: 40.5 });
  });

  it("reads anything missing or wrong as the start", () => {
    const start = { panel: "library", treeScroll: 0, sheetScroll: 0 };
    assert.deepEqual(parseViewState(null), start);
    assert.deepEqual(parseViewState("{"), start);
    assert.deepEqual(parseViewState("7"), start);
    assert.deepEqual(parseViewState(JSON.stringify({ panel: "elsewhere", treeScroll: -5, sheetScroll: "x" })), start);
  });
});
