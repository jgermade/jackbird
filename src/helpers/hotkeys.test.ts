import assert from "node:assert/strict";
import { test } from "node:test";
import { isPlayPauseKey, isSearchKey } from "./hotkeys.ts";

test("isPlayPauseKey is Space alone, not held down", () => {
  const press = (parts: Partial<Parameters<typeof isPlayPauseKey>[0]>) => ({ key: " ", repeat: false, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...parts });
  assert.equal(isPlayPauseKey(press({})), true);
  assert.equal(isPlayPauseKey(press({ repeat: true })), false);
  assert.equal(isPlayPauseKey(press({ shiftKey: true })), false);
  assert.equal(isPlayPauseKey(press({ ctrlKey: true })), false);
  assert.equal(isPlayPauseKey(press({ metaKey: true })), false);
  assert.equal(isPlayPauseKey(press({ altKey: true })), false);
  assert.equal(isPlayPauseKey(press({ key: "Enter" })), false);
});

test("isSearchKey is Ctrl or ⌘ with F, or / where nothing is typed", () => {
  const press = (parts: Partial<Parameters<typeof isSearchKey>[0]>) => ({ key: "f", repeat: false, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...parts });
  assert.equal(isSearchKey(press({ ctrlKey: true }), false), true);
  assert.equal(isSearchKey(press({ metaKey: true, key: "F" }), true), true);
  assert.equal(isSearchKey(press({ ctrlKey: true, shiftKey: true }), false), false);
  assert.equal(isSearchKey(press({ ctrlKey: true, altKey: true }), false), false);
  assert.equal(isSearchKey(press({ ctrlKey: true, repeat: true }), false), false);
  assert.equal(isSearchKey(press({}), false), false);
  assert.equal(isSearchKey(press({ key: "/" }), false), true);
  assert.equal(isSearchKey(press({ key: "/" }), true), false);
  assert.equal(isSearchKey(press({ key: "/", ctrlKey: true }), false), false);
});
