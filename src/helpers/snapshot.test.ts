import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { MetaSnapshot } from "../types.ts";
import { emptySnapshot, parseMetaSnapshot, serializeMetaSnapshot } from "./snapshot.ts";

const snapshot: MetaSnapshot = {
  version: 1,
  tracks: {
    "Jazz/01.mp3": {
      checksum: "abc",
      size: 1000,
      metadata: { title: "So What", artist: "Miles Davis", album: "Kind of Blue", year: "1959", genre: "Jazz", trackNumber: "1", coverDataUrl: null },
      updatedAt: "2026-11-03T19:00:00.000Z"
    }
  }
};

describe("parseMetaSnapshot", () => {
  it("reads a version-1 snapshot", () => {
    assert.deepEqual(parseMetaSnapshot(JSON.stringify(snapshot)), snapshot);
  });

  it("reads an empty or blank file as empty", () => {
    assert.deepEqual(parseMetaSnapshot(""), emptySnapshot());
    assert.deepEqual(parseMetaSnapshot("  \n "), emptySnapshot());
  });

  it("reads broken JSON as empty", () => {
    assert.deepEqual(parseMetaSnapshot("{ \"version\": 1, "), emptySnapshot());
  });

  it("reads anything that is not a version-1 snapshot with tracks as empty", () => {
    assert.deepEqual(parseMetaSnapshot("null"), emptySnapshot());
    assert.deepEqual(parseMetaSnapshot("[]"), emptySnapshot());
    assert.deepEqual(parseMetaSnapshot(JSON.stringify({ version: 2, tracks: {} })), emptySnapshot());
    assert.deepEqual(parseMetaSnapshot(JSON.stringify({ version: 1 })), emptySnapshot());
  });
});

describe("serializeMetaSnapshot", () => {
  it("writes JSON indented by two spaces that reads back the same", () => {
    const text = serializeMetaSnapshot(snapshot);
    assert.match(text, /^\{\n  "version": 1,/);
    assert.deepEqual(parseMetaSnapshot(text), snapshot);
  });
});

describe("emptySnapshot", () => {
  it("is version 1 with no tracks, new each time", () => {
    assert.deepEqual(emptySnapshot(), { version: 1, tracks: {} });
    assert.notEqual(emptySnapshot(), emptySnapshot());
  });
});
