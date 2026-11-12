import assert from "node:assert/strict";
import { test } from "node:test";
import { COMPACT, compactSize, isCompactShortcut, NO_COMPACT, parseCompactState, pipSize, remToPx } from "./compact.ts";

test("remToPx turns rem into pixels at the root's size, and falls back to 16px", () => {
  assert.equal(remToPx(30, 18), 540);
  assert.equal(remToPx(7, 18), 126);
  assert.equal(remToPx(1.5, 15), 23);
  assert.equal(remToPx(2, 0), 32);
  assert.equal(remToPx(2, Number.NaN), 32);
});

test("compactSize and pipSize follow the root's font size", () => {
  assert.deepEqual(compactSize(18), { width: 612, height: 126, minWidth: 360, minHeight: 108 });
  assert.deepEqual(compactSize(16), { width: 544, height: 112, minWidth: 320, minHeight: 96 });
  assert.deepEqual(pipSize(18), { width: 612, height: 158 });
  assert.equal(COMPACT.pipHeight, 8.75);
});

test("parseCompactState keeps what is well formed and defaults the rest", () => {
  assert.deepEqual(parseCompactState(null), NO_COMPACT);
  assert.deepEqual(parseCompactState(""), NO_COMPACT);
  assert.deepEqual(parseCompactState("{not json"), NO_COMPACT);
  assert.deepEqual(parseCompactState("42"), NO_COMPACT);
  assert.deepEqual(parseCompactState("null"), NO_COMPACT);
  const full = { x: 10, y: 20.4, width: 1280, height: 800, maximized: true };
  assert.deepEqual(parseCompactState(JSON.stringify({ on: true, onTop: true, compact: { x: -5, y: 3, width: 540, height: 126 }, full })), {
    on: true,
    onTop: true,
    compact: { x: -5, y: 3, width: 540, height: 126 },
    full: { x: 10, y: 20, width: 1280, height: 800, maximized: true }
  });
  // Truthy but not true is not on; bad bounds are dropped.
  assert.deepEqual(parseCompactState(JSON.stringify({ on: 1, onTop: "yes", compact: { x: 1, y: 2, width: 0, height: 5 }, full: { x: 1, y: 2, width: "3", height: 4 } })), NO_COMPACT);
  assert.deepEqual(parseCompactState(JSON.stringify({ compact: "here", full: { x: 0, y: 0, width: 10, height: 10 } })), {
    ...NO_COMPACT,
    full: { x: 0, y: 0, width: 10, height: 10, maximized: false }
  });
});

test("isCompactShortcut is Ctrl+Shift+M, or Cmd+Shift+M on macOS", () => {
  const press = (parts: Partial<Parameters<typeof isCompactShortcut>[0]>) => ({ key: "M", ctrlKey: false, metaKey: false, shiftKey: true, altKey: false, ...parts });
  assert.equal(isCompactShortcut(press({ ctrlKey: true }), false), true);
  assert.equal(isCompactShortcut(press({ ctrlKey: true, key: "m" }), false), true);
  assert.equal(isCompactShortcut(press({ metaKey: true }), false), false);
  assert.equal(isCompactShortcut(press({ metaKey: true }), true), true);
  assert.equal(isCompactShortcut(press({ ctrlKey: true }), true), false);
  assert.equal(isCompactShortcut(press({ ctrlKey: true, metaKey: true }), false), false);
  assert.equal(isCompactShortcut(press({ ctrlKey: true, shiftKey: false }), false), false);
  assert.equal(isCompactShortcut(press({ ctrlKey: true, altKey: true }), false), false);
  assert.equal(isCompactShortcut(press({ ctrlKey: true, key: "n" }), false), false);
});
