import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { detectBpm, tempoWeight } from "./bpm.ts";

const RATE = 11_025;

/** A seeded white noise source (mulberry32): a plain LCG's low bits repeat, and read as a beat. */
function noiseSource(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296 - 0.5;
  };
}

/** A click track: a short decaying tone on every beat, `seconds` long, with `noise` under it. */
function clicks(bpm: number, seconds: number, options: { noise?: number; offbeat?: number; seed?: number } = {}): Float32Array {
  const out = new Float32Array(Math.round(seconds * RATE));
  const random = noiseSource(options.seed ?? 1);
  const beat = (60 / bpm) * RATE;
  const hit = (at: number, gain: number) => {
    for (let i = 0; i < 600 && at + i < out.length; i += 1) out[at + i] += gain * Math.sin((2 * Math.PI * 180 * i) / RATE) * Math.exp(-i / 120);
  };
  for (let n = 0; n * beat < out.length; n += 1) {
    hit(Math.round(n * beat), 1);
    if (options.offbeat) hit(Math.round((n + 0.5) * beat), options.offbeat);
  }
  if (options.noise) for (let i = 0; i < out.length; i += 1) out[i] += options.noise * random();
  return out;
}

describe("detectBpm", () => {
  it("tells the tempo of a click track, to the whole beat", () => {
    for (const bpm of [84, 90, 100, 120, 128, 140, 155]) {
      assert.equal(Math.round(detectBpm(clicks(bpm, 40), RATE) ?? 0), bpm, `${bpm} BPM`);
    }
  });

  it("tells it under noise, and with softer off-beats", () => {
    assert.equal(Math.round(detectBpm(clicks(110, 40, { noise: 0.4 }), RATE) ?? 0), 110);
    assert.equal(Math.round(detectBpm(clicks(96, 40, { offbeat: 0.35 }), RATE) ?? 0), 96);
  });

  it("looks at the middle of a long song", () => {
    const song = new Float32Array(RATE * 200);
    song.set(clicks(122, 90), RATE * 55);
    assert.equal(Math.round(detectBpm(song, RATE) ?? 0), 122);
  });

  it("finds none in steady noise", () => {
    const random = noiseSource(7);
    const noise = new Float32Array(RATE * 20).map(() => random());
    assert.equal(detectBpm(noise, RATE), null);
  });

  it("finds none in silence, nor in a few seconds", () => {
    assert.equal(detectBpm(new Float32Array(RATE * 30), RATE), null);
    assert.equal(detectBpm(clicks(120, 3), RATE), null);
  });
});

describe("tempoWeight", () => {
  it("is whole between 80 and 160, less an octave away", () => {
    assert.equal(tempoWeight(120), 1);
    assert.equal(tempoWeight(80), 1);
    // A step down just outside, then less the further away.
    assert.ok(tempoWeight(79) <= 0.7);
    assert.ok(tempoWeight(60) < tempoWeight(79));
    assert.ok(tempoWeight(200) < tempoWeight(161));
  });
});
