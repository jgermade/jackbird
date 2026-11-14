import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PeakFall } from "../types.ts";
import {
  DEFAULT_PEAK_FALL,
  DISPLAY_BANDS,
  PEAK_FALLS,
  SPECTRUM_DECIBELS,
  SPECTRUM_LOOKS,
  SPECTRUM_RANGE,
  SPECTRUM_TILT,
  foldBands,
  peakFallOf,
  peakMotion,
  spectrumBands,
  spectrumLookOf
} from "./spectrum.ts";

// An analyser's 512 bins (fftSize 1024) at the two usual rates.
const BINS = 512;
const at = (hz: number, rate: number) => Math.round(hz / (rate / 2 / BINS));

/** Bins with only the bin nearest `hz` at full level. */
function tone(hz: number, rate: number): Uint8Array {
  const bins = new Uint8Array(BINS);
  bins[at(hz, rate)] = 255;
  return bins;
}

describe("spectrumBands", () => {
  it("gives one level per band, from 0 to 1", () => {
    const levels = spectrumBands(new Uint8Array(BINS).fill(255), 16, 48000);
    assert.equal(levels.length, 16);
    assert.ok(levels.every((level) => level === 1));
    assert.ok(spectrumBands(new Uint8Array(BINS), 16, 48000).every((level) => level === 0));
  });

  it("shows a tone in the same band at 44.1 and 48 kHz", () => {
    for (const hz of [100, 440, 1000, 5000, 12000]) {
      const at44 = spectrumBands(tone(hz, 44100), 16, 44100).findIndex((level) => level > 0);
      const at48 = spectrumBands(tone(hz, 48000), 16, 48000).findIndex((level) => level > 0);
      assert.ok(at44 >= 0 && Math.abs(at44 - at48) <= 1, `${hz} Hz: band ${at44} at 44.1 kHz, ${at48} at 48 kHz`);
    }
  });

  it("leaves out DC and what is above the range", () => {
    const bins = new Uint8Array(BINS);
    bins[0] = 255;
    bins.fill(255, at(SPECTRUM_RANGE.high, 48000) + 1);
    assert.ok(spectrumBands(bins, 16, 48000).every((level) => level === 0));
  });

  it("lights the last band for what is just under the range's top", () => {
    const levels = spectrumBands(tone(15000, 48000), 16, 48000);
    assert.ok(levels[15] > 0);
  });

  it("gives the low end narrower bands than the high end", () => {
    // 40 Hz to 16 kHz in 16 bands: the first bands are one bin each, the last over a hundred.
    const bins = new Uint8Array(BINS);
    bins.fill(255, 1, 5);
    const levels = spectrumBands(bins, 16, 48000);
    assert.ok(levels.slice(0, 4).every((level) => level === 1));
    assert.ok(levels.slice(6).every((level) => level === 0));
  });

  it("averages the bins of a band", () => {
    // One band over the whole range: bins 1 to 341 at 48 kHz, one of them lit.
    const bins = new Uint8Array(BINS);
    bins[100] = 255;
    const [level] = spectrumBands(bins, 1, 48000);
    assert.equal(level, 1 / (at(SPECTRUM_RANGE.high, 48000) - 1));
  });

  it("repeats the last bin when the bands run past it", () => {
    // Two bins at 8 kHz reach 4 kHz: the bands above it show the last bin.
    const levels = spectrumBands([0, 255], 4, 8000, { low: 1000, high: 16000 });
    assert.equal(levels.length, 4);
    assert.ok(levels.every((level) => level === 1));
  });

  it("is empty without bins, bands or a rate", () => {
    assert.deepEqual(spectrumBands([], 16, 48000), []);
    assert.deepEqual(spectrumBands([255], 0, 48000), []);
    assert.deepEqual(spectrumBands([255], 16, 0), []);
  });

  it("with a tilt, shows a spectrum falling by it as level", () => {
    // Bins falling 3 dB an octave from 40 Hz (byte 200 there), over -100 to -10 dB.
    const rate = 48000;
    const binHz = rate / 2 / BINS;
    const span = SPECTRUM_DECIBELS.max - SPECTRUM_DECIBELS.min;
    const bins = Uint8Array.from({ length: BINS }, (_, k) =>
      k === 0 ? 0 : Math.max(0, Math.round(200 - (SPECTRUM_TILT * Math.log2((k * binHz) / 40) * 255) / span))
    );
    const flat = spectrumBands(bins, 16, rate, SPECTRUM_RANGE, SPECTRUM_TILT);
    const spread = Math.max(...flat) - Math.min(...flat);
    assert.ok(spread < 0.08, `levels ${flat.map((level) => level.toFixed(2)).join(" ")}`);
    // Without it, the same bins fall from the bass to the treble.
    const falling = spectrumBands(bins, 16, rate);
    assert.ok(falling[0] - falling[15] > 0.2);
  });

  it("with a tilt, lowers the bass, raises the treble, and keeps silence dark", () => {
    const half = new Uint8Array(BINS).fill(128);
    const levels = spectrumBands(half, 16, 48000, SPECTRUM_RANGE, SPECTRUM_TILT);
    assert.ok(levels[0] < 128 / 255 && levels[15] > 128 / 255);
    assert.ok(spectrumBands(new Uint8Array(BINS), 16, 48000, SPECTRUM_RANGE, SPECTRUM_TILT).every((level) => level === 0));
    // Never past 0 or 1.
    const loud = spectrumBands(new Uint8Array(BINS).fill(255), 16, 48000, SPECTRUM_RANGE, 30);
    const faint = spectrumBands(new Uint8Array(BINS).fill(1), 16, 48000, SPECTRUM_RANGE, 30);
    assert.ok(loud.every((level) => level <= 1) && faint.every((level) => level >= 0));
  });
});

describe("foldBands", () => {
  it("gives each group the highest band of its run, low first", () => {
    assert.deepEqual(foldBands([0.1, 0.5, 0.2, 0.9, 0.3, 0.4], 3), [0.5, 0.9, 0.4]);
  });

  it("folds the display's bands into a row's three bars, each from a third of them", () => {
    const levels = Array.from({ length: DISPLAY_BANDS }, (_, band) => band / DISPLAY_BANDS);
    assert.deepEqual(foldBands(levels, 3), [7 / 24, 15 / 24, 23 / 24]);
  });

  it("repeats bands when there are more groups than bands", () => {
    assert.deepEqual(foldBands([0.2, 0.8], 4), [0.2, 0.2, 0.8, 0.8]);
  });

  it("gives nothing for no levels or no groups", () => {
    assert.deepEqual(foldBands([], 3), []);
    assert.deepEqual(foldBands([0.5], 0), []);
  });
});

describe("spectrumLookOf", () => {
  it("takes a look it knows", () => {
    for (const look of SPECTRUM_LOOKS) assert.equal(spectrumLookOf(look), look);
  });

  it("gives segments for anything else", () => {
    assert.equal(spectrumLookOf(null), "segments");
    assert.equal(spectrumLookOf("bars"), "segments");
  });
});

describe("peakFallOf", () => {
  it("takes a fall it knows", () => {
    for (const fall of PEAK_FALLS) assert.equal(peakFallOf(fall), fall);
  });

  it("gives the default, fast, for anything else", () => {
    assert.equal(DEFAULT_PEAK_FALL, "fast");
    assert.equal(peakFallOf(undefined), "fast");
    assert.equal(peakFallOf("slowest"), "fast");
  });
});

describe("peakMotion", () => {
  it("draws no peaks for none", () => {
    assert.equal(peakMotion("none"), null);
  });

  it("keeps the fast fall as it was: held 600 ms, then 0.4 of the height a second", () => {
    assert.deepEqual(peakMotion("fast"), { hold: 600, speed: 0.4 });
  });

  it("holds longer and falls slower, the slower the choice", () => {
    const [fast, slow, verySlow] = (["fast", "slow", "very-slow"] as const).map((fall) => peakMotion(fall)!);
    assert.ok(slow.hold > fast.hold && verySlow.hold > slow.hold);
    assert.ok(slow.speed < fast.speed && verySlow.speed < slow.speed);
  });

  it("gives the default's motion for a fall it does not know", () => {
    assert.deepEqual(peakMotion("huge" as PeakFall), peakMotion("fast"));
  });
});
