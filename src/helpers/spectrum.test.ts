import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { spectrumBands } from "./spectrum.ts";

describe("spectrumBands", () => {
  it("gives one level per band, from 0 to 1", () => {
    const full = new Uint8Array(128).fill(255);
    const levels = spectrumBands(full, 16);
    assert.equal(levels.length, 16);
    assert.ok(levels.every((level) => level === 1));
    assert.ok(spectrumBands(new Uint8Array(128), 16).every((level) => level === 0));
  });

  it("gives the low end narrower bands than the high end", () => {
    // Only the first eight bins sound: on a linear split they would all fall in the first band.
    const bins = new Uint8Array(128);
    bins.fill(255, 0, 8);
    const levels = spectrumBands(bins, 16);
    assert.ok(levels.slice(0, 4).every((level) => level > 0));
    assert.ok(levels.slice(10).every((level) => level === 0));
  });

  it("averages the bins of a band", () => {
    assert.deepEqual(spectrumBands([0, 255], 1), [127.5 / 255]);
  });

  it("keeps a band at least one bin wide when there are more bands than bins", () => {
    const levels = spectrumBands([255, 0], 4);
    assert.equal(levels.length, 4);
    assert.equal(levels[0], 1);
  });

  it("is empty without bins or bands", () => {
    assert.deepEqual(spectrumBands([], 16), []);
    assert.deepEqual(spectrumBands([255], 0), []);
  });
});
