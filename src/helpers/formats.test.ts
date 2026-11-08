import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AUDIO_FORMATS, audioFormatOf, audioMimeType, isAudioFile } from "./formats.ts";

describe("audio formats", () => {
  it("are MP3 and FLAC", () => {
    assert.deepEqual(
      AUDIO_FORMATS.map((format) => format.extension),
      [".mp3", ".flac"]
    );
  });

  it("are told by extension, in any case, wherever the file is", () => {
    assert.equal(audioFormatOf("Jazz/So What.mp3")?.name, "MP3");
    assert.equal(audioFormatOf("Jazz/Blue in Green.FLAC")?.name, "FLAC");
    assert.equal(audioFormatOf("a.Flac")?.mime, "audio/flac");
  });

  it("leave out every other file", () => {
    for (const path of ["cover.jpg", "list.m3u8", ".meta/mp3-manager.json", "mp3", "a.flac.txt", "flac", ""]) {
      assert.equal(audioFormatOf(path), null, path);
      assert.equal(isAudioFile(path), false, path);
    }
    assert.equal(isAudioFile("x.mp3"), true);
  });

  it("give the MIME type the player uses, or an empty one", () => {
    assert.equal(audioMimeType("x.mp3"), "audio/mpeg");
    assert.equal(audioMimeType("x.flac"), "audio/flac");
    assert.equal(audioMimeType("x.ogg"), "");
  });
});
