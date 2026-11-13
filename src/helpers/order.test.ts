import assert from "node:assert/strict";
import { test } from "node:test";
import { isOrderOf, nextIndex, nextRepeat, previousIndex, shuffledOrder, upcoming, type PlayMode } from "./order.ts";

const mode = (parts: Partial<PlayMode> = {}): PlayMode => ({ repeat: "off", shuffle: false, order: [], ...parts });

test("in the queue's order, to the end", () => {
  assert.deepEqual(upcoming(1, 4, mode()), [2, 3]);
  assert.equal(nextIndex(1, 4, mode()), 2);
  assert.equal(nextIndex(3, 4, mode()), 3);
  assert.equal(previousIndex(1, 4, mode()), 0);
  assert.equal(previousIndex(0, 4, mode()), 0);
  assert.deepEqual(upcoming(0, 0, mode()), []);
  assert.equal(nextIndex(0, 0, mode()), 0);
  assert.equal(previousIndex(0, 0, mode()), 0);
});

test("repeating all goes round; repeating one stays", () => {
  assert.deepEqual(upcoming(2, 4, mode({ repeat: "all" })), [3, 0, 1, 2]);
  assert.equal(nextIndex(3, 4, mode({ repeat: "all" })), 0);
  assert.equal(previousIndex(0, 4, mode({ repeat: "all" })), 3);
  assert.deepEqual(upcoming(2, 4, mode({ repeat: "one" })), []);
  assert.equal(nextIndex(2, 4, mode({ repeat: "one" })), 2);
  assert.deepEqual(upcoming(0, 1, mode({ repeat: "all" })), [0]);
});

test("shuffled, the order given; a stale one is the queue's", () => {
  const order = [2, 0, 3, 1];
  assert.deepEqual(upcoming(2, 4, mode({ shuffle: true, order })), [0, 3, 1]);
  assert.equal(nextIndex(3, 4, mode({ shuffle: true, order })), 1);
  assert.equal(previousIndex(3, 4, mode({ shuffle: true, order })), 0);
  assert.deepEqual(upcoming(1, 4, mode({ shuffle: true, order, repeat: "all" })), [2, 0, 3, 1]);
  assert.deepEqual(upcoming(1, 5, mode({ shuffle: true, order })), [2, 3, 4]);
});

test("shuffledOrder puts the first first and every index once", () => {
  let seed = 0.37;
  const random = () => (seed = (seed * 9301 + 0.49297) % 1);
  const order = shuffledOrder(6, 4, random);
  assert.equal(order[0], 4);
  assert.equal(isOrderOf(order, 6), true);
  assert.deepEqual(shuffledOrder(1, 0), [0]);
  assert.deepEqual(shuffledOrder(0, 0), []);
  assert.equal(isOrderOf(shuffledOrder(3, -1), 3), true);
  assert.equal(isOrderOf([0, 0, 1], 3), false);
  assert.equal(isOrderOf([0, 1], 3), false);
  assert.equal(isOrderOf([0, 1, 3], 3), false);
});

test("nextRepeat turns off, the whole queue, this track, off", () => {
  assert.equal(nextRepeat("off"), "all");
  assert.equal(nextRepeat("all"), "one");
  assert.equal(nextRepeat("one"), "off");
});
