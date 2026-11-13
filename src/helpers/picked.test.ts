import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { folderAccess, isHandheld, splitPicked } from "./picked.ts";

describe("folderAccess", () => {
  it("reads and writes with the picker, whatever else there is", () => {
    assert.equal(folderAccess({ picker: true, folderInput: true, handheld: false }), "full");
    assert.equal(folderAccess({ picker: true, folderInput: false, handheld: true }), "full");
  });
  it("only reads with a folder input, on a computer", () => {
    assert.equal(folderAccess({ picker: false, folderInput: true, handheld: false }), "read");
  });
  it("opens nothing on a phone with only the input, or with neither", () => {
    assert.equal(folderAccess({ picker: false, folderInput: true, handheld: true }), "none");
    assert.equal(folderAccess({ picker: false, folderInput: false, handheld: false }), "none");
  });
});

describe("isHandheld", () => {
  it("knows phones and tablets, an iPad passing as a Mac by its touch", () => {
    assert.equal(isHandheld("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)", 5), true);
    assert.equal(isHandheld("Mozilla/5.0 (Linux; Android 15)", 5), true);
    assert.equal(isHandheld("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", 5), true);
  });
  it("leaves computers out", () => {
    assert.equal(isHandheld("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", 0), false);
    assert.equal(isHandheld("Mozilla/5.0 (Windows NT 10.0; Win64; x64)", 0), false);
  });
});

describe("splitPicked", () => {
  it("splits the chosen folder's name from the path under it", () => {
    assert.deepEqual(splitPicked("Music/One.mp3"), { folder: "Music", path: "One.mp3" });
    assert.deepEqual(splitPicked("Music//Album/Two.flac"), { folder: "Music", path: "Album/Two.flac" });
  });
  it("is null for a path with no folder", () => {
    assert.equal(splitPicked("loose.mp3"), null);
    assert.equal(splitPicked(""), null);
  });
});
