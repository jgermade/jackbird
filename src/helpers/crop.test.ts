import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_ZOOM, clampView, coverScale, sourceRect, zoomView } from "./crop.ts";

const wide = { width: 400, height: 200 };

describe("crop", () => {
  it("covers the frame with the picture's shorter side", () => {
    assert.equal(coverScale(wide, 100), 0.5);
    assert.equal(coverScale({ width: 100, height: 300 }, 300), 3);
  });

  it("keeps the zoom in range and the picture's edges outside the frame", () => {
    assert.deepEqual(clampView(wide, 100, { zoom: 0.5, x: 0, y: 0 }), { zoom: 1, x: 0, y: 0 });
    assert.equal(clampView(wide, 100, { zoom: 9, x: 0, y: 0 }).zoom, MAX_ZOOM);
    // At zoom 1 the wide picture is 200 × 100 over a 100 frame: 50 spare each side across, none down.
    assert.deepEqual(clampView(wide, 100, { zoom: 1, x: 80, y: 30 }), { zoom: 1, x: 50, y: 0 });
  });

  it("zooms round the frame's centre", () => {
    assert.deepEqual(zoomView(wide, 100, { zoom: 1, x: 20, y: 0 }, 2), { zoom: 2, x: 40, y: 0 });
  });

  it("gives the part of the picture the frame shows", () => {
    // Centred at zoom 1: the middle 200 × 200 of the 400 × 200 picture.
    assert.deepEqual(sourceRect(wide, 100, { zoom: 1, x: 0, y: 0 }), { sx: 100, sy: 0, side: 200 });
    // Moved right as far as it goes: its left part shows.
    assert.deepEqual(sourceRect(wide, 100, { zoom: 1, x: 50, y: 0 }), { sx: 0, sy: 0, side: 200 });
    // Zoom 2: a 100 × 100 square from the middle.
    assert.deepEqual(sourceRect(wide, 100, { zoom: 2, x: 0, y: 0 }), { sx: 150, sy: 50, side: 100 });
  });
});
