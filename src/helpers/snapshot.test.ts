import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { MetaSnapshot } from "../types.ts";
import { track } from "./fixtures.test-support.ts";
import { applyScanResults, applyVerification, checksumOf, emptySnapshot, omitRecords, parseMetaSnapshot, serializeMetaSnapshot } from "./snapshot.ts";

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

describe("checksumOf", () => {
  it("is the full checksum, else the legacy one", () => {
    assert.equal(checksumOf({ ...track("a.mp3"), checksum: "old", fullChecksum: "full" }), "full");
    assert.equal(checksumOf({ ...track("a.mp3"), checksum: "old" }), "old");
  });
});

describe("applyVerification", () => {
  const now = "2026-11-04T01:00:00.000Z";
  const before = "2026-11-01T00:00:00.000Z";
  const tagged = (path: string, title: string) => ({
    ...track(path, { title }),
    checksum: `sum-${title}`,
    fullChecksum: `sum-${title}`,
    audioChecksum: "audio",
    size: 1000,
    lastModified: 111,
    lastVerifiedAt: before
  });
  const recordOf = (one: ReturnType<typeof tagged>) => ({
    checksum: one.fullChecksum,
    fullChecksum: one.fullChecksum,
    audioChecksum: "audio",
    size: one.size,
    lastModified: one.lastModified,
    lastVerifiedAt: before,
    metadata: one.metadata,
    updatedAt: before
  });
  const soWhat = tagged("so-what.mp3", "So What");
  const hunter = tagged("hunter.mp3", "Hunter");
  const root = {
    id: "root",
    tracks: [soWhat, hunter],
    metaSnapshot: { version: 1 as const, tracks: { "so-what.mp3": recordOf(soWhat), "hunter.mp3": recordOf(hunter) } }
  };

  it("records the checksums and the time on the track and its record, keeping the tags", () => {
    const next = applyVerification(root, "so-what.mp3", "sum-So What", { fullChecksum: "sum-So What", audioChecksum: "audio-2" }, now);
    assert.ok(next);
    assert.deepEqual(next.tracks[0], { ...soWhat, audioChecksum: "audio-2", lastVerifiedAt: now });
    assert.deepEqual(next.metaSnapshot.tracks["so-what.mp3"], { ...recordOf(soWhat), audioChecksum: "audio-2", lastVerifiedAt: now });
  });

  it("leaves everything else as it was, and changes nothing it was given", () => {
    const copy = structuredClone(root);
    const next = applyVerification(root, "so-what.mp3", "sum-So What", { fullChecksum: "sum-So What", audioChecksum: "audio" }, now);
    assert.ok(next);
    assert.equal(next.id, "root");
    assert.equal(next.tracks[1], hunter);
    assert.equal(next.metaSnapshot.tracks["hunter.mp3"], root.metaSnapshot.tracks["hunter.mp3"]);
    assert.deepEqual(root, copy);
  });

  it("takes the tags, size and date the file has now when it changed", () => {
    const file = { metadata: { ...soWhat.metadata, title: "Edited elsewhere" }, size: 2000, lastModified: 222 };
    const next = applyVerification(root, "so-what.mp3", "sum-So What", { fullChecksum: "sum-new", audioChecksum: "audio-new", file }, now);
    assert.ok(next);
    assert.deepEqual(next.tracks[0], { ...soWhat, ...file, checksum: "sum-new", fullChecksum: "sum-new", audioChecksum: "audio-new", lastVerifiedAt: now });
    assert.deepEqual(next.metaSnapshot.tracks["so-what.mp3"], {
      checksum: "sum-new",
      fullChecksum: "sum-new",
      audioChecksum: "audio-new",
      size: 2000,
      lastModified: 222,
      lastVerifiedAt: now,
      metadata: file.metadata,
      updatedAt: now
    });
  });

  it("creates the record when the snapshot has none", () => {
    const bare = { ...root, metaSnapshot: emptySnapshot() };
    const next = applyVerification(bare, "hunter.mp3", "sum-Hunter", { fullChecksum: "sum-Hunter", audioChecksum: "audio" }, now);
    assert.equal(next?.metaSnapshot.tracks["hunter.mp3"].updatedAt, now);
  });

  it("does not apply to a track that is gone", () => {
    assert.equal(applyVerification(root, "gone.mp3", "sum-So What", { fullChecksum: "x", audioChecksum: "y" }, now), null);
  });

  it("does not apply when the track was recorded again since its file was read", () => {
    const saved = { ...root, tracks: [{ ...soWhat, checksum: "sum-saved", fullChecksum: "sum-saved" }, hunter] };
    assert.equal(applyVerification(saved, "so-what.mp3", "sum-So What", { fullChecksum: "sum-saved", audioChecksum: "audio" }, now), null);
  });
});

describe("applyScanResults", () => {
  const now = "2026-11-04T12:00:00.000Z";
  const loading = { ...track("Jazz/so-what.mp3"), checksum: "" };
  const known = { ...track("Jazz/hunter.mp3", { title: "Hunter" }), checksum: "old", fullChecksum: "old" };
  const root = {
    id: "root",
    tracks: [loading, known],
    metaSnapshot: {
      version: 1,
      tracks: { "Jazz/hunter.mp3": { checksum: "old", fullChecksum: "old", metadata: known.metadata, updatedAt: "before" } }
    } as MetaSnapshot
  };
  const recordFor = (title: string, sum: string) => ({
    checksum: sum,
    fullChecksum: sum,
    audioChecksum: `audio-${sum}`,
    size: 2000,
    lastModified: 222,
    lastVerifiedAt: now,
    metadata: { ...loading.metadata, title },
    updatedAt: now
  });

  it("sets each track read and its record, as new objects", () => {
    const copy = structuredClone(root);
    const record = recordFor("So What", "new");
    const next = applyScanResults(root, [{ trackId: "Jazz/so-what.mp3", readFrom: "", record }]);
    assert.deepEqual(next.tracks[0], {
      ...loading,
      checksum: "new",
      fullChecksum: "new",
      audioChecksum: "audio-new",
      size: 2000,
      lastModified: 222,
      lastVerifiedAt: now,
      metadata: record.metadata
    });
    assert.equal(next.tracks[1], known);
    assert.deepEqual(next.metaSnapshot.tracks["Jazz/so-what.mp3"], record);
    assert.deepEqual(next.metaSnapshot.tracks["Jazz/hunter.mp3"], root.metaSnapshot.tracks["Jazz/hunter.mp3"]);
    assert.deepEqual(root, copy);
  });

  it("keeps a track's size when the record has none", () => {
    const { size: _size, ...record } = recordFor("So What", "new");
    const next = applyScanResults(root, [{ trackId: "Jazz/so-what.mp3", readFrom: "", record }]);
    assert.equal(next.tracks[0].size, 1000);
  });

  it("leaves out a track saved since its file was read, and one that is gone", () => {
    const saved = { ...root, tracks: [loading, { ...known, checksum: "saved", fullChecksum: "saved" }] };
    const next = applyScanResults(saved, [
      { trackId: "Jazz/hunter.mp3", readFrom: "old", record: recordFor("Hunter (old)", "old-read") },
      { trackId: "Jazz/gone.mp3", readFrom: "", record: recordFor("Gone", "gone") }
    ]);
    assert.equal(next, saved);
  });

  it("applies the results that still hold and skips the rest", () => {
    const saved = { ...root, tracks: [loading, { ...known, checksum: "saved", fullChecksum: "saved" }] };
    const next = applyScanResults(saved, [
      { trackId: "Jazz/so-what.mp3", readFrom: "", record: recordFor("So What", "new") },
      { trackId: "Jazz/hunter.mp3", readFrom: "old", record: recordFor("Hunter (old)", "old-read") }
    ]);
    assert.equal(next.tracks[0].fullChecksum, "new");
    assert.equal(next.tracks[1].fullChecksum, "saved");
    assert.equal(next.metaSnapshot.tracks["Jazz/hunter.mp3"], root.metaSnapshot.tracks["Jazz/hunter.mp3"]);
  });
});

describe("omitRecords", () => {
  const records: MetaSnapshot = {
    version: 1,
    tracks: {
      "a.mp3": { checksum: "a", metadata: track("a.mp3").metadata, updatedAt: "t" },
      "b.mp3": { checksum: "b", metadata: track("b.mp3").metadata, updatedAt: "t" }
    }
  };

  it("drops the records of the paths given, as a new snapshot", () => {
    const next = omitRecords(records, ["a.mp3", "missing.mp3"]);
    assert.deepEqual(Object.keys(next.tracks), ["b.mp3"]);
    assert.deepEqual(Object.keys(records.tracks), ["a.mp3", "b.mp3"]);
  });

  it("is the snapshot itself when none of the paths is in it", () => {
    assert.equal(omitRecords(records, ["missing.mp3"]), records);
    assert.equal(omitRecords(records, []), records);
  });
});
