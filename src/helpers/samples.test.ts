import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseSampleList } from "./samples.ts";

describe("parseSampleList", () => {
  it("reads a label and its tracks", () => {
    assert.deepEqual(parseSampleList({ label: " Sample music ", files: ["One.mp3", "Two.flac"] }), {
      label: "Sample music",
      files: ["One.mp3", "Two.flac"]
    });
  });
  it("is null for anything that is not a list of tracks", () => {
    assert.equal(parseSampleList(null), null);
    assert.equal(parseSampleList("samples"), null);
    assert.equal(parseSampleList({ files: ["One.mp3"] }), null);
    assert.equal(parseSampleList({ label: "", files: ["One.mp3"] }), null);
    assert.equal(parseSampleList({ label: "Music", files: [] }), null);
    assert.equal(parseSampleList({ label: "Music", files: "One.mp3" }), null);
    assert.equal(parseSampleList({ label: "Music", files: ["notes.txt"] }), null);
  });
  it("takes no path, in the label or the files", () => {
    assert.equal(parseSampleList({ label: "a/b", files: ["One.mp3"] }), null);
    assert.equal(parseSampleList({ label: "Music", files: ["../One.mp3"] }), null);
    assert.equal(parseSampleList({ label: "Music", files: ["sub\\One.mp3"] }), null);
  });
});
