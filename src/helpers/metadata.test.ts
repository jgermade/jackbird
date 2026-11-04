import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { track } from "./fixtures.test-support.ts";
import { computeCommonMetadata, emptyMetadata, getVariedFields, mergeDraft } from "./metadata.ts";

const kindOfBlue = { artist: "Miles Davis", album: "Kind of Blue", year: "1959", genre: "Jazz", coverDataUrl: "data:cover" };

describe("emptyMetadata", () => {
  it("has every field empty and no cover", () => {
    assert.deepEqual(emptyMetadata(), { title: "", artist: "", album: "", year: "", genre: "", trackNumber: "", coverDataUrl: null });
  });

  it("returns a new object each time", () => {
    assert.notEqual(emptyMetadata(), emptyMetadata());
  });
});

describe("computeCommonMetadata", () => {
  it("is empty for no tracks", () => {
    assert.deepEqual(computeCommonMetadata([]), emptyMetadata());
  });

  it("is a copy of a single track's metadata", () => {
    const one = track("a.mp3", { ...kindOfBlue, title: "So What", trackNumber: "1" });
    const common = computeCommonMetadata([one]);
    assert.deepEqual(common, one.metadata);
    assert.notEqual(common, one.metadata);
  });

  it("keeps what the tracks share and empties what differs", () => {
    const common = computeCommonMetadata([
      track("a.mp3", { ...kindOfBlue, title: "So What", trackNumber: "1" }),
      track("b.mp3", { ...kindOfBlue, title: "Blue in Green", trackNumber: "3" })
    ]);
    assert.deepEqual(common, { ...kindOfBlue, title: "", trackNumber: "" });
  });

  it("empties every field that differs, and drops a differing cover", () => {
    const common = computeCommonMetadata([
      track("a.mp3", { title: "A", artist: "A", album: "A", year: "1", genre: "A", trackNumber: "1", coverDataUrl: "data:a" }),
      track("b.mp3", { title: "B", artist: "B", album: "B", year: "2", genre: "B", trackNumber: "2", coverDataUrl: "data:b" })
    ]);
    assert.deepEqual(common, emptyMetadata());
  });
});

describe("getVariedFields", () => {
  const none = { title: false, artist: false, album: false, year: false, genre: false, trackNumber: false, coverDataUrl: false };

  it("varies in nothing for no tracks or one", () => {
    assert.deepEqual(getVariedFields([]), none);
    assert.deepEqual(getVariedFields([track("a.mp3", { title: "So What" })]), none);
  });

  it("marks the fields that differ from the first track", () => {
    const varied = getVariedFields([
      track("a.mp3", { ...kindOfBlue, title: "So What", trackNumber: "1" }),
      track("b.mp3", { ...kindOfBlue, title: "So What", trackNumber: "2" }),
      track("c.mp3", { ...kindOfBlue, title: "All Blues", trackNumber: "2", coverDataUrl: null })
    ]);
    assert.deepEqual(varied, { ...none, title: true, trackNumber: true, coverDataUrl: true });
  });
});

describe("mergeDraft", () => {
  const original = { title: "So What", artist: "Miles Davis", album: "Kind of Blue", year: "1959", genre: "Jazz", trackNumber: "1", coverDataUrl: "data:cover" };
  const nothingVaried = getVariedFields([]);
  const everythingVaried = { title: true, artist: true, album: true, year: true, genre: true, trackNumber: true, coverDataUrl: true };

  it("takes the draft whole when nothing varied, empty fields and no cover included", () => {
    assert.deepEqual(mergeDraft(original, emptyMetadata(), nothingVaried), emptyMetadata());
  });

  it("keeps the track's value where the selection varied and the draft is empty", () => {
    assert.deepEqual(mergeDraft(original, emptyMetadata(), everythingVaried), original);
  });

  it("writes what the draft says over a varied field", () => {
    const draft = { ...emptyMetadata(), title: "Freddie Freeloader", year: "1960", coverDataUrl: "data:new" };
    assert.deepEqual(mergeDraft(original, draft, everythingVaried), { ...original, title: "Freddie Freeloader", year: "1960", coverDataUrl: "data:new" });
  });

  it("clears a shared field the draft emptied, and a shared cover it removed", () => {
    const varied = { ...nothingVaried, title: true };
    const draft = { ...original, title: "", genre: "", coverDataUrl: null };
    assert.deepEqual(mergeDraft(original, draft, varied), { ...original, genre: "", coverDataUrl: null });
  });

  it("clears a varied field the draft left empty when it is confirmed", () => {
    assert.deepEqual(mergeDraft(original, emptyMetadata(), everythingVaried, ["genre", "year"]), { ...original, genre: "", year: "" });
  });

  it("returns a new object", () => {
    assert.notEqual(mergeDraft(original, original, nothingVaried), original);
  });
});
