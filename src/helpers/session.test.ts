import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sameSession, sessionOf } from "./session.ts";

const music = { name: "Music" };
const podcasts = { name: "Podcasts" };
const open = [
  { id: "1", label: "Music", rootHandle: music, groupingMode: "wizard" as const, tracks: [] },
  { id: "2", label: "Podcasts", rootHandle: podcasts, groupingMode: "flat" as const, tracks: [] }
];

describe("sessionOf", () => {
  it("keeps each root's id, label, handle and grouping, in order, and the active id", () => {
    assert.deepEqual(sessionOf(open, "2"), {
      roots: [
        { id: "1", label: "Music", handle: music, groupingMode: "wizard" },
        { id: "2", label: "Podcasts", handle: podcasts, groupingMode: "flat" }
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
});
