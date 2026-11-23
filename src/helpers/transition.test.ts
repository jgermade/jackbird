import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CROSSFADE_DEFAULT, GAPLESS_LEAD, TRANSITIONS, crossfadeSecondsOf, fadeLevels, overlapOf, transitionOf, transitionStep } from "./transition.ts";

describe("transitionOf", () => {
  it("names a way, else the default", () => {
    for (const way of TRANSITIONS) assert.equal(transitionOf(way), way);
    assert.equal(transitionOf("fade"), "normal");
    assert.equal(transitionOf(null), "normal");
  });
});

describe("crossfadeSecondsOf", () => {
  it("takes whole seconds from 1 to 12", () => {
    assert.equal(crossfadeSecondsOf("4"), 4);
    assert.equal(crossfadeSecondsOf(7.4), 7);
    assert.equal(crossfadeSecondsOf(0), 1);
    assert.equal(crossfadeSecondsOf("30"), 12);
  });

  it("is the default when nothing, or nothing of a number, is saved", () => {
    assert.equal(crossfadeSecondsOf(null), CROSSFADE_DEFAULT);
    assert.equal(crossfadeSecondsOf(""), CROSSFADE_DEFAULT);
    assert.equal(crossfadeSecondsOf("six"), CROSSFADE_DEFAULT);
  });
});

describe("overlapOf", () => {
  it("is the crossfade, at most half of either song", () => {
    assert.equal(overlapOf(6, 200, 180), 6);
    assert.equal(overlapOf(6, 8, 180), 4);
    assert.equal(overlapOf(6, 200, 5), 2.5);
  });

  it("is none when a length is not known", () => {
    assert.equal(overlapOf(6, 0, 180), 0);
    assert.equal(overlapOf(6, 200, Number.NaN), 0);
  });
});

describe("fadeLevels", () => {
  it("goes from the ending song to the starting one at equal power", () => {
    assert.deepEqual(fadeLevels(0), { ending: 1, starting: 0 });
    const end = fadeLevels(1);
    assert.ok(Math.abs(end.ending) < 1e-12 && end.starting === 1);
    const middle = fadeLevels(0.5);
    assert.ok(Math.abs(middle.ending ** 2 + middle.starting ** 2 - 1) < 1e-12);
    assert.ok(Math.abs(middle.ending - middle.starting) < 1e-12);
  });

  it("holds outside 0 to 1", () => {
    assert.deepEqual(fadeLevels(-1), fadeLevels(0));
    assert.deepEqual(fadeLevels(2), fadeLevels(1));
  });
});

describe("transitionStep", () => {
  it("never acts as it always did", () => {
    assert.deepEqual(transitionStep("normal", 0.1, 200, 180, 6), { kind: "wait" });
  });

  it("starts the next song gapless as this one ends", () => {
    assert.deepEqual(transitionStep("gapless", 30, 200, 180, 6), { kind: "wait" });
    assert.deepEqual(transitionStep("gapless", 0.4, 200, 180, 6), { kind: "start", delay: 0.4 });
    assert.deepEqual(transitionStep("gapless", GAPLESS_LEAD, 200, 0, 6), { kind: "start", delay: GAPLESS_LEAD });
  });

  it("fades the next song in over the crossfade's last seconds", () => {
    assert.deepEqual(transitionStep("crossfade", 7, 200, 180, 6), { kind: "wait" });
    assert.deepEqual(transitionStep("crossfade", 5.8, 200, 180, 6), { kind: "fade", overlap: 6 });
    assert.deepEqual(transitionStep("crossfade", 3, 8, 180, 6), { kind: "fade", overlap: 4 });
  });

  it("follows gapless when a crossfade's length cannot be known", () => {
    assert.deepEqual(transitionStep("crossfade", 5, 200, 0, 6), { kind: "wait" });
    assert.deepEqual(transitionStep("crossfade", 0.5, 200, 0, 6), { kind: "start", delay: 0.5 });
  });

  it("waits on a position not known", () => {
    assert.deepEqual(transitionStep("crossfade", Number.NaN, 200, 180, 6), { kind: "wait" });
  });
});
