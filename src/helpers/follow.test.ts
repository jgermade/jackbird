import assert from "node:assert/strict";
import { test } from "node:test";
import { byCaret, followFolder } from "./follow.ts";

test("a click opens a folder, as opened by a click", () => {
  assert.deepEqual(followFolder({ expanded: [], auto: [] }, "Jazz", []), { expanded: ["Jazz"], auto: ["Jazz"] });
  // Open already (by its caret): it stays the person's.
  assert.deepEqual(followFolder({ expanded: ["Jazz"], auto: [] }, "Jazz", []), { expanded: ["Jazz"], auto: [] });
});

test("the folders a click opened close once the current row leaves them", () => {
  const state = { expanded: ["Jazz", "Rock"], auto: ["Jazz"] };
  assert.deepEqual(followFolder(state, "Pop", []), { expanded: ["Rock", "Pop"], auto: ["Pop"] });
  // Into it (a subfolder, a track): it stays open.
  assert.deepEqual(followFolder(state, "Jazz/Miles", ["Jazz"]), { expanded: ["Jazz", "Rock", "Jazz/Miles"], auto: ["Jazz", "Jazz/Miles"] });
  assert.deepEqual(followFolder(state, null, ["Jazz"]), state);
  // A track elsewhere: it closes; the caret's stay.
  assert.deepEqual(followFolder(state, null, ["Rock"]), { expanded: ["Rock"], auto: [] });
});

test("byCaret makes a folder the person's", () => {
  assert.deepEqual(byCaret(["Jazz", "Pop"], "Jazz"), ["Pop"]);
  assert.deepEqual(byCaret([], "Jazz"), []);
});
