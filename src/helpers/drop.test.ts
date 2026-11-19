import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { emptyMetadata } from "./metadata.ts";
import { DEFAULT_COMPILATION_PATTERN, DEFAULT_DROP_PATTERN, dropPath, freePath, missingTags, patternFor, patternTags, recoverTags, tagsChanged, tidyTags } from "./drop.ts";

const song = (tags: Partial<ReturnType<typeof emptyMetadata>>) => ({ ...emptyMetadata(), ...tags });

describe("patternTags and missingTags", () => {
  it("names the tags a pattern uses, once each", () => {
    assert.deepEqual(patternTags(DEFAULT_DROP_PATTERN), ["artist", "year", "album", "trackNumber", "title"]);
    assert.deepEqual(patternTags("%title% %TITLE% %filename% %nope%"), ["title"]);
  });

  it("names those a song lacks", () => {
    assert.deepEqual(missingTags(DEFAULT_DROP_PATTERN, song({ title: "Song", artist: "Band", album: " " })), ["year", "album", "trackNumber"]);
  });
});

describe("tidyTags", () => {
  it("trims, makes runs of spaces one and keeps a year's four digits", () => {
    const tidy = tidyTags(song({ title: "  Livin'   On A Prayer ", year: "1986-08-18", trackNumber: " 3/12 " }));
    assert.equal(tidy.title, "Livin' On A Prayer");
    assert.equal(tidy.year, "1986");
    assert.equal(tidy.trackNumber, "3/12");
    assert.ok(tagsChanged(song({ title: "  a" }), tidyTags(song({ title: "  a" }))));
    assert.ok(!tagsChanged(song({ title: "a" }), tidyTags(song({ title: "a" }))));
  });
});

describe("recoverTags", () => {
  it("reads only what the song lacks from its dropped path", () => {
    const read = recoverTags("%artist% - %album%/%track% %title%", "Downloads/Bon Jovi - Slippery When Wet/03 Livin' On A Prayer.flac", song({ title: "Prayer" }));
    assert.deepEqual(read, { artist: "Bon Jovi", album: "Slippery When Wet", trackNumber: "3" });
    assert.deepEqual(recoverTags("%artist% - %title%", "x.mp3", song({})), {});
  });
});

describe("dropPath", () => {
  it("lays a song out by the pattern, its extension kept", () => {
    const tags = song({ artist: "Bon Jovi", year: "1986", album: "Slippery When Wet", trackNumber: "3/12", title: "Livin' On A Prayer" });
    assert.equal(dropPath(DEFAULT_DROP_PATTERN, "x.FLAC", tags), "Bon Jovi/1986 - Slippery When Wet/03 Livin' On A Prayer.FLAC");
  });

  it("tidies a part a missing field leaves, and leaves out an empty one", () => {
    const tags = song({ artist: "Bon Jovi", album: "Greatest Hits", title: "Always" });
    assert.equal(dropPath(DEFAULT_DROP_PATTERN, "a.mp3", tags), "Bon Jovi/Greatest Hits/Always.mp3");
    assert.equal(dropPath("%artist%/%album% (%year%)/%title%", "a.mp3", song({ title: "T" })), "T.mp3");
  });

  it("makes each part safe, and falls back on the name with nothing left", () => {
    assert.equal(dropPath("%artist%/%title%", "a.mp3", song({ artist: "AC/DC", title: "What? Now" })), "AC_DC/What_ Now.mp3");
    assert.equal(dropPath("%title%", "orig.mp3", song({})), "orig.mp3");
  });
});

describe("patternFor", () => {
  it("takes the compilations' pattern for a song its tags mark as one", () => {
    const tags = song({ artist: "Various", album: "Now 1", trackNumber: "7", title: "Hit", compilation: "1" });
    const pattern = patternFor(tags, DEFAULT_DROP_PATTERN, DEFAULT_COMPILATION_PATTERN);
    assert.equal(pattern, DEFAULT_COMPILATION_PATTERN);
    // The folder's own name keeps its underscore.
    assert.equal(dropPath(pattern, "x.mp3", tags), "_compilations/Now 1/07 Hit.mp3");
  });

  it("keeps everyone's pattern for any other song, or with no compilations' pattern", () => {
    assert.equal(patternFor(song({ compilation: "0" }), DEFAULT_DROP_PATTERN, DEFAULT_COMPILATION_PATTERN), DEFAULT_DROP_PATTERN);
    assert.equal(patternFor(song({}), DEFAULT_DROP_PATTERN, DEFAULT_COMPILATION_PATTERN), DEFAULT_DROP_PATTERN);
    assert.equal(patternFor(song({ compilation: "1" }), DEFAULT_DROP_PATTERN, "  "), DEFAULT_DROP_PATTERN);
  });
});

describe("freePath", () => {
  it("adds a number where the path is taken, without case", () => {
    assert.equal(freePath("A/b.mp3", new Set()), "A/b.mp3");
    assert.equal(freePath("A/b.mp3", new Set(["a/b.mp3", "a/b (2).mp3"])), "A/b (3).mp3");
    assert.equal(freePath("A.b/c", new Set(["a.b/c"])), "A.b/c (2)");
  });
});

describe("the rest of the cases", () => {
  it("leaves a tag the song has, and reads nothing from a name that does not match", () => {
    assert.deepEqual(recoverTags("%artist% - %title%", "Band - Song.mp3", song({ artist: "Mine" })), { title: "Song" });
    assert.deepEqual(recoverTags("%artist% - %title%", "nothing here.mp3", song({})), {});
  });

  it("tidies the separators and brackets a missing field leaves", () => {
    assert.equal(dropPath("%artist% - - %album% [%year%] (%genre%)/%title%", "a.mp3", song({ artist: "A", album: "B", title: "T" })), "A - B/T.mp3");
    assert.equal(dropPath("%title%", "noext", song({ title: "T" })), "T");
  });

  it("keeps a year with no four digits as it is, and tidies a song with nothing to tidy", () => {
    assert.equal(tidyTags(song({ year: "86" })).year, "86");
    const odd = { ...song({}), comment: null } as unknown as ReturnType<typeof emptyMetadata>;
    assert.equal(tidyTags(odd).comment, "");
    assert.deepEqual(missingTags("%comment%", odd), ["comment"]);
  });
});
