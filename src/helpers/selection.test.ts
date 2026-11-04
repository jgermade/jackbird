import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chosenState, nextSelection, selectMany } from "./selection.ts";

const order = ["a", "b", "c", "d", "e"];
const none = { selected: [], anchor: null };

describe("nextSelection, toggle", () => {
  it("adds a track and makes it the anchor of a fresh selection", () => {
    assert.deepEqual(nextSelection(none, "b", "toggle", order), { selected: ["b"], anchor: "b" });
  });

  it("adds more tracks, keeping the anchor", () => {
    assert.deepEqual(nextSelection({ selected: ["b"], anchor: "b" }, "d", "toggle", order), { selected: ["b", "d"], anchor: "b" });
  });

  it("removes a selected track", () => {
    assert.deepEqual(nextSelection({ selected: ["b", "d"], anchor: "b" }, "b", "toggle", order), { selected: ["d"], anchor: "b" });
  });
});

describe("nextSelection, range", () => {
  it("selects from the anchor to the track, forwards or backwards, keeping what was selected", () => {
    assert.deepEqual(nextSelection({ selected: ["b"], anchor: "b" }, "d", "range", order), { selected: ["b", "c", "d"], anchor: "b" });
    assert.deepEqual(nextSelection({ selected: ["e", "d"], anchor: "d" }, "b", "range", order), { selected: ["e", "d", "b", "c"], anchor: "d" });
  });

  it("extends from the first selected track when there is no anchor", () => {
    assert.deepEqual(nextSelection({ selected: ["c"], anchor: null }, "a", "range", order), { selected: ["c", "a", "b"], anchor: "a" });
  });

  it("selects just the track when nothing is selected", () => {
    assert.deepEqual(nextSelection(none, "c", "range", order), { selected: ["c"], anchor: "c" });
  });

  it("selects just the track when either end is not shown", () => {
    assert.deepEqual(nextSelection({ selected: ["x"], anchor: "x" }, "c", "range", order), { selected: ["c"], anchor: "x" });
    assert.deepEqual(nextSelection({ selected: ["b"], anchor: "b" }, "zz", "range", order), { selected: ["zz"], anchor: "b" });
  });
});

describe("selectMany", () => {
  it("adds every track, keeping the selection and its anchor", () => {
    assert.deepEqual(selectMany({ selected: ["e"], anchor: "e" }, ["a", "b", "e"], true), { selected: ["e", "a", "b"], anchor: "e" });
  });

  it("anchors a fresh selection on the first track", () => {
    assert.deepEqual(selectMany(none, ["c", "d"], true), { selected: ["c", "d"], anchor: "c" });
    assert.deepEqual(selectMany(none, [], true), { selected: [], anchor: null });
  });

  it("removes every track, keeping the others and the anchor", () => {
    assert.deepEqual(selectMany({ selected: ["a", "b", "e"], anchor: "a" }, ["a", "b"], false), { selected: ["e"], anchor: "a" });
  });
});

describe("chosenState", () => {
  it("says whether all, some or none of the tracks are selected", () => {
    assert.equal(chosenState(["a", "b", "x"], ["a", "b"]), "all");
    assert.equal(chosenState(["a", "x"], ["a", "b"]), "some");
    assert.equal(chosenState(["x"], ["a", "b"]), "none");
    assert.equal(chosenState(["x"], []), "none");
  });
});
