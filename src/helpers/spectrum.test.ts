import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SPECTRUM_RANGE, spectrumBands } from "./spectrum.ts";

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
});
