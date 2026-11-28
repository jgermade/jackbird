import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AUDIO_FORMATS, audioFormatOf, audioMimeType, codecFamily, codecLabel, formatLabel, isAudioFile } from "./formats.ts";

describe("audio formats", () => {
  it("are MP3, FLAC and MPEG-4 audio", () => {
    assert.deepEqual(
      AUDIO_FORMATS.map((format) => format.extension),
      [".mp3", ".flac", ".m4a"]
    );
    assert.equal(audioMimeType("Jazz/So What.M4A"), "audio/mp4");
    assert.equal(isAudioFile("iPod_Control/Music/F00/ABCD.m4a"), true);
    // Protected songs, audiobooks and bare AAC streams are not tracks the engine reads.
    for (const path of ["a.m4p", "b.m4b", "c.aac", "d.mp4"]) assert.equal(isAudioFile(path), false, path);
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

describe("the format a track's row shows", () => {
  it("names a known format, else the extension in capitals, else nothing", () => {
    assert.equal(formatLabel("Jazz/So What.mp3"), "MP3");
    assert.equal(formatLabel("Jazz/Blue in Green.FLAC"), "FLAC");
    assert.equal(formatLabel("iPod_Control/Music/F00/ABCD.m4a"), "M4A");
    assert.equal(formatLabel("Jazz.d/notes"), "");
    assert.equal(formatLabel(".hidden"), "");
    assert.equal(formatLabel("trailing."), "");
  });
});

describe("codecLabel", () => {
  it("names MP3 and FLAC by their extension", () => {
    assert.equal(codecLabel("a/b.mp3"), "MP3");
    assert.equal(codecLabel("a/b.FLAC", { bitrate: 900 }), "FLAC");
  });
  it("tells an iPod's Apple Lossless from its AAC by the bitrate", () => {
    assert.equal(codecLabel("iPod_Control/Music/F00/ABCD.m4a", { bitrate: 256 }), "AAC");
    assert.equal(codecLabel("iPod_Control/Music/F00/ABCD.m4a", { bitrate: 401 }), "ALAC");
    assert.equal(codecLabel("iPod_Control/Music/F00/ABCD.m4a"), "AAC");
    assert.equal(codecLabel("iPod_Control/Music/F00/ABCD.m4a", null), "AAC");
  });
  it("takes what the iPod's database names first, in any language", () => {
    assert.equal(codecLabel("iPod_Control/Music/F00/ABCD.m4a", { bitrate: 1000, kind: "AAC audio file" }), "AAC");
    assert.equal(codecLabel("iPod_Control/Music/F00/ABCD.m4a", { bitrate: 128, kind: "Apple Lossless audio file" }), "ALAC");
    assert.equal(codecLabel("x.m4a", { kind: "Archivo de audio AAC adquirido" }), "AAC");
    assert.equal(codecLabel("x.mp3", { kind: "Archivo de audio MPEG" }), "MP3");
    assert.equal(codecLabel("x.wav", { kind: "WAV audio file" }), "WAV");
    assert.equal(codecLabel("x.aif", { kind: "AIFF audio file" }), "AIFF");
    // A type it does not know: the path decides.
    assert.equal(codecLabel("x.m4a", { bitrate: 900, kind: "Audiobook" }), "ALAC");
  });
  it("names the other MPEG-4 audio AAC, and PCM and Ogg by their family", () => {
    assert.deepEqual(["x.m4p", "x.m4b", "x.aac", "x.wav", "x.aif", "x.aiff", "x.oga", "x.ogg", "x.opus", "x", "x.wma"].map((path) => codecLabel(path)), ["AAC", "AAC", "AAC", "WAV", "AIFF", "AIFF", "OGG", "OGG", "OPUS", "", "WMA"]);
  });
});

describe("codecFamily", () => {
  it("gives each codec CodecMark's family, in any case", () => {
    assert.equal(codecFamily("FLAC"), "flac");
    assert.equal(codecFamily("mp3"), "mp3");
    assert.equal(codecFamily("AAC"), "aac");
    assert.equal(codecFamily("ALAC"), "alac");
    assert.equal(codecFamily("WAV"), "pcm");
    assert.equal(codecFamily("AIFF"), "pcm");
    assert.equal(codecFamily(" opus "), "ogg");
    assert.equal(codecFamily("VORBIS"), "ogg");
  });

  it("any other is other", () => {
    assert.equal(codecFamily("WMA"), "other");
    assert.equal(codecFamily(""), "other");
  });
});
