import assert from "node:assert/strict";
import { test } from "node:test";
import { nameDiff } from "./namediff.ts";

test("nameDiff marks what is added at the end", () => {
  assert.deepEqual(nameDiff("01 - A Little Love.mp3", "01 - A Little Love ssa.mp3"), {
    before: [{ text: "01 - A Little Love.mp3", changed: false }],
    after: [
      { text: "01 - A Little Love", changed: false },
      { text: " ssa", changed: true },
      { text: ".mp3", changed: false }
    ]
  });
});

test("nameDiff marks what is removed and what replaces it", () => {
  assert.deepEqual(nameDiff("01 - Goodbye.mp3", "Biffy Clyro - Goodbye.mp3"), {
    before: [
      { text: "01", changed: true },
      { text: " - Goodbye.mp3", changed: false }
    ],
    // The space the old name kept before " - " is the new one's after "Clyro": one change.
    after: [
      { text: "Biffy Clyro ", changed: true },
      { text: "- Goodbye.mp3", changed: false }
    ]
  });
});

test("nameDiff of the same name, and of nothing", () => {
  assert.deepEqual(nameDiff("a.mp3", "a.mp3"), { before: [{ text: "a.mp3", changed: false }], after: [{ text: "a.mp3", changed: false }] });
  assert.deepEqual(nameDiff("", "b.mp3"), { before: [], after: [{ text: "b.mp3", changed: true }] });
  assert.deepEqual(nameDiff("Café", "café"), { before: [{ text: "Café", changed: true }], after: [{ text: "café", changed: true }] });
});
