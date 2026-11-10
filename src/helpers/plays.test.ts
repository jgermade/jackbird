import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { countsAsPlayed, ownPlaylistPaths, PLAY_CAP_SECONDS } from "./plays.ts";

describe("countsAsPlayed", () => {
  it("counts half a song, or four minutes of a long one", () => {
    assert.equal(countsAsPlayed(59, 120), false);
    assert.equal(countsAsPlayed(60, 120), true);
    assert.equal(countsAsPlayed(PLAY_CAP_SECONDS - 1, 1200), false);
    assert.equal(countsAsPlayed(PLAY_CAP_SECONDS, 1200), true);
  });

  it("counts nothing without a duration", () => {
    assert.equal(countsAsPlayed(10, 0), false);
    assert.equal(countsAsPlayed(10, Number.NaN), false);
    assert.equal(countsAsPlayed(Number.NaN, 100), false);
  });
});

describe("ownPlaylistPaths", () => {
  it("reads the songs of a playlist of one's own folder", () => {
    assert.deepEqual(ownPlaylistPaths("#EXTM3U\n../Music/a.mp3\r\n\n../Uploads/b.flac\n"), ["Music/a.mp3", "Uploads/b.flac"]);
    assert.deepEqual(ownPlaylistPaths("#EXTM3U\n"), []);
  });
});
