import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { track } from "./fixtures.test-support.ts";
import { collectFolderPaths, inferDiscNumber, orderDetailPlaylist, trackNumberOrder, tracksToVerify, VERIFICATION_TTL_MS } from "./tracks.ts";

describe("inferDiscNumber", () => {
  it("reads the disc from a CD or Disc folder, in any case and separator", () => {
    assert.equal(inferDiscNumber(track("Album/CD2/01.mp3")), 2);
    assert.equal(inferDiscNumber(track("Album/disc 3/01.mp3")), 3);
    assert.equal(inferDiscNumber(track("Album/Disc_10/01.mp3")), 10);
    assert.equal(inferDiscNumber(track("cd-4/01.mp3")), 4);
  });

  it("takes the disc tag first, its number before any total", () => {
    assert.equal(inferDiscNumber(track("Album/CD2/01.mp3", { discNumber: "3/4" })), 3);
    assert.equal(inferDiscNumber(track("Album/01.mp3", { discNumber: "2" })), 2);
    assert.equal(inferDiscNumber(track("Album/CD2/01.mp3", { discNumber: "0" })), 2);
    assert.equal(inferDiscNumber(track("Album/01.mp3", { discNumber: "x" })), 1);
  });

  it("is disc 1 when no folder names one", () => {
    assert.equal(inferDiscNumber(track("Album/01.mp3")), 1);
    assert.equal(inferDiscNumber(track("Album/cd2.mp3")), 1);
    assert.equal(inferDiscNumber(track("Album/CDs/01.mp3")), 1);
  });
});

describe("trackNumberOrder", () => {
  it("is the first number in the track number", () => {
    assert.equal(trackNumberOrder(track("a.mp3", { trackNumber: "07" })), 7);
    assert.equal(trackNumberOrder(track("a.mp3", { trackNumber: "3/12" })), 3);
    assert.equal(trackNumberOrder(track("a.mp3", { trackNumber: "Side B, 2" })), 2);
  });

  it("sorts a track without one last", () => {
    assert.equal(trackNumberOrder(track("a.mp3")), Number.POSITIVE_INFINITY);
  });
});

describe("orderDetailPlaylist", () => {
  const names = (tracks: ReturnType<typeof track>[]) => orderDetailPlaylist(tracks).map((one) => one.relativePath);

  it("orders by album, then disc, then track number", () => {
    assert.deepEqual(
      names([
        track("B/CD2/01.mp3", { album: "Beta", trackNumber: "1" }),
        track("B/CD1/02.mp3", { album: "Beta", trackNumber: "2" }),
        track("A/03.mp3", { album: "Alpha", trackNumber: "3" }),
        track("B/CD1/01.mp3", { album: "Beta", trackNumber: "1" }),
        track("A/01.mp3", { album: "Alpha", trackNumber: "1" })
      ]),
      ["A/01.mp3", "A/03.mp3", "B/CD1/01.mp3", "B/CD1/02.mp3", "B/CD2/01.mp3"]
    );
  });

  it("orders discs numerically", () => {
    assert.deepEqual(names([track("X/CD10/01.mp3"), track("X/CD2/01.mp3")]), ["X/CD2/01.mp3", "X/CD10/01.mp3"]);
  });

  it("groups untagged tracks by their first folder", () => {
    assert.deepEqual(
      names([track("Zeta/01.mp3", { trackNumber: "1" }), track("Alpha/02.mp3", { album: "Mid", trackNumber: "1" })]),
      ["Alpha/02.mp3", "Zeta/01.mp3"]
    );
  });

  it("orders by file name when track numbers tie or are missing", () => {
    assert.deepEqual(names([track("A/b.mp3", { trackNumber: "1" }), track("A/a.mp3", { trackNumber: "1" })]), ["A/a.mp3", "A/b.mp3"]);
    assert.deepEqual(names([track("A/b.mp3"), track("A/a.mp3")]), ["A/a.mp3", "A/b.mp3"]);
  });

  it("puts numbered tracks before unnumbered ones", () => {
    assert.deepEqual(names([track("A/a.mp3"), track("A/z.mp3", { trackNumber: "9" })]), ["A/z.mp3", "A/a.mp3"]);
  });

  it("leaves the input array alone", () => {
    const input = [track("B/01.mp3"), track("A/01.mp3")];
    orderDetailPlaylist(input);
    assert.deepEqual(input.map((one) => one.relativePath), ["B/01.mp3", "A/01.mp3"]);
  });
});

describe("collectFolderPaths", () => {
  it("lists every folder at every depth once", () => {
    assert.deepEqual(
      collectFolderPaths([track("Jazz/Miles/Kind of Blue/01.mp3"), track("Jazz/Miles/Kind of Blue/02.mp3"), track("Jazz/Nina/01.mp3")]),
      ["Jazz", "Jazz/Miles", "Jazz/Miles/Kind of Blue", "Jazz/Nina"]
    );
  });

  it("has nothing for tracks at the root", () => {
    assert.deepEqual(collectFolderPaths([track("01.mp3")]), []);
  });
});

describe("tracksToVerify", () => {
  const now = Date.parse("2026-11-04T12:00:00Z");
  const at = (msAgo: number): string => new Date(now - msAgo).toISOString();
  const verified = (path: string, audioChecksum: string | undefined, lastVerifiedAt: string | undefined) => ({ ...track(path), audioChecksum, lastVerifiedAt });

  it("leaves out tracks verified within the last day", () => {
    const fresh = verified("fresh.mp3", "a", at(VERIFICATION_TTL_MS - 1));
    assert.deepEqual(tracksToVerify([fresh], now), []);
  });

  it("keeps stale tracks, and those missing a checksum or a date", () => {
    const stale = verified("stale.mp3", "a", at(VERIFICATION_TTL_MS + 1));
    const noChecksum = verified("no-checksum.mp3", undefined, at(1000));
    const noDate = verified("no-date.mp3", "a", undefined);
    assert.deepEqual(tracksToVerify([stale, noChecksum, noDate], now).map((one) => one.id).sort(), ["no-checksum.mp3", "no-date.mp3", "stale.mp3"]);
  });

  it("puts tracks with no audio checksum first, then the oldest verification first", () => {
    const old = verified("old.mp3", "a", at(10 * VERIFICATION_TTL_MS));
    const older = verified("older.mp3", "a", at(20 * VERIFICATION_TTL_MS));
    const never = verified("never.mp3", "a", undefined);
    const bare = verified("bare.mp3", undefined, undefined);
    const bareRecent = verified("bare-recent.mp3", undefined, at(1000));
    assert.deepEqual(tracksToVerify([old, bareRecent, older, never, bare], now).map((one) => one.id), [
      "bare.mp3",
      "bare-recent.mp3",
      "never.mp3",
      "older.mp3",
      "old.mp3"
    ]);
  });

  it("does not reorder the list it is given", () => {
    const list = [verified("b.mp3", "a", undefined), verified("a.mp3", undefined, undefined)];
    tracksToVerify(list, now);
    assert.deepEqual(list.map((one) => one.id), ["b.mp3", "a.mp3"]);
  });
});
