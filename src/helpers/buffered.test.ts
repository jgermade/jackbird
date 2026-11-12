import assert from "node:assert/strict";
import { test } from "node:test";
import { bufferedTo, rangesOf } from "./buffered.ts";

test("bufferedTo is the end of the range the position is in", () => {
  assert.equal(bufferedTo([{ start: 0, end: 40 }], 12, 155), 40);
  assert.equal(bufferedTo([{ start: 0, end: 10 }, { start: 60, end: 90 }], 70, 155), 90);
  // A seek lands just before a range.
  assert.equal(bufferedTo([{ start: 60.3, end: 90 }], 60, 155), 90);
});

test("bufferedTo is 0 out of every range, and the length when it reaches the end", () => {
  assert.equal(bufferedTo([{ start: 0, end: 10 }], 30, 155), 0);
  assert.equal(bufferedTo([], 0, 155), 0);
  assert.equal(bufferedTo([{ start: 0, end: 154.8 }], 3, 155), 155);
  assert.equal(bufferedTo([{ start: 0, end: 20 }], Number.NaN, 0), 20);
  assert.equal(bufferedTo([{ start: 0, end: 20 }], -4, Number.POSITIVE_INFINITY), 20);
});

test("rangesOf reads a TimeRanges-like object", () => {
  const starts = [0, 50];
  const ends = [10, 70];
  assert.deepEqual(rangesOf({ length: 2, start: (i) => starts[i], end: (i) => ends[i] }), [
    { start: 0, end: 10 },
    { start: 50, end: 70 }
  ]);
  assert.deepEqual(rangesOf({ length: 0, start: () => 0, end: () => 0 }), []);
});
