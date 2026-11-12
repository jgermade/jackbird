import assert from "node:assert/strict";
import { test } from "node:test";
import { isPlayPauseKey } from "./hotkeys.ts";

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
