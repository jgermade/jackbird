import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { QUARANTINE_DIR, expiredInQuarantine, folderOf, inQuarantine, quarantinePath } from "./quarantine.ts";

const now = new Date("2026-11-25T15:00:00Z");

describe("a folder's quarantine", () => {
  it("puts a deleted song under the day's folder, with its path", () => {
    assert.equal(quarantinePath("Album/01 - Song.mp3", now), ".jackbird-trash/2026-11-25/Album/01 - Song.mp3");
    assert.equal(quarantinePath("/top.flac", now), ".jackbird-trash/2026-11-25/top.flac");
  });

  it("tells what is in it", () => {
    assert.equal(inQuarantine(`${QUARANTINE_DIR}/2026-11-25/a.mp3`), true);
    assert.equal(inQuarantine(QUARANTINE_DIR), true);
    assert.equal(inQuarantine(".jackbird-trashy/a.mp3"), false);
    assert.equal(inQuarantine("Album/a.mp3"), false);
  });

  it("gives the folder a path is in", () => {
    assert.equal(folderOf("a/b/c.mp3"), "a/b");
    assert.equal(folderOf("c.mp3"), "");
  });

  it("finds what has been there 30 days or more", () => {
    const paths = [
      ".jackbird-trash/2026-10-26/old.mp3",
      ".jackbird-trash/2026-10-27/young.mp3",
      ".jackbird-trash/2026-11-25/today.mp3",
      ".jackbird-trash/stray.mp3",
      ".jackbird-trash/2026-99-99/bad.mp3",
      "Album/a.mp3"
    ];
    assert.deepEqual(expiredInQuarantine(paths, now), [".jackbird-trash/2026-10-26/old.mp3"]);
    assert.deepEqual(expiredInQuarantine(paths, now, 0), [".jackbird-trash/2026-10-26/old.mp3", ".jackbird-trash/2026-10-27/young.mp3", ".jackbird-trash/2026-11-25/today.mp3"]);
  });
});
