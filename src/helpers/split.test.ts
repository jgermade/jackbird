import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SPLIT, clampSplit, parseSplit, splitByKey } from "./split.ts";

describe("clampSplit", () => {
  it("keeps a width that fits", () => {
    assert.equal(clampSplit(30, 70), 30);
  });
  it("keeps the library and the sheet at their least", () => {
    assert.equal(clampSplit(4, 70), SPLIT.minLibrary);
    assert.equal(clampSplit(65, 70), 70 - SPLIT.minSheet);
  });
  it("gives the library its least when the panes are too narrow for both", () => {
    assert.equal(clampSplit(30, 30), SPLIT.minLibrary);
  });
  it("starts from the initial width for one that is not a number", () => {
    assert.equal(clampSplit(Number.NaN, 70), SPLIT.initial);
  });
});

describe("parseSplit", () => {
  it("reads a stored width", () => {
    assert.equal(parseSplit("28.5"), 28.5);
  });
  it("is null for none, or anything not a width", () => {
    assert.equal(parseSplit(null), null);
    assert.equal(parseSplit(""), null);
    assert.equal(parseSplit("wide"), null);
    assert.equal(parseSplit("-3"), null);
    assert.equal(parseSplit("Infinity"), null);
  });
});

describe("splitByKey", () => {
  it("moves a rem with the arrows, to the ends with Home and End", () => {
    assert.equal(splitByKey("ArrowLeft", 25, 70), 24);
    assert.equal(splitByKey("ArrowRight", 25, 70), 26);
    assert.equal(splitByKey("Home", 25, 70), SPLIT.minLibrary);
    assert.equal(splitByKey("End", 25, 70), 70 - SPLIT.minSheet);
  });
  it("stays within the room", () => {
    assert.equal(splitByKey("ArrowLeft", SPLIT.minLibrary, 70), SPLIT.minLibrary);
  });
  it("is null for any other key", () => {
    assert.equal(splitByKey("Enter", 25, 70), null);
  });
});
