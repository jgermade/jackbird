import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { track } from "./fixtures.test-support.ts";
import { collectFolderPaths, inferDiscLabel, orderDetailPlaylist, trackNumberOrder } from "./tracks.ts";

describe("inferDiscLabel", () => {
  it("reads the disc from a CD or Disc folder, in any case and separator", () => {
    assert.equal(inferDiscLabel(track("Album/CD2/01.mp3")), "Disco 2");
    assert.equal(inferDiscLabel(track("Album/disc 3/01.mp3")), "Disco 3");
    assert.equal(inferDiscLabel(track("Album/Disc_10/01.mp3")), "Disco 10");
    assert.equal(inferDiscLabel(track("cd-4/01.mp3")), "Disco 4");
  });

  it("is disc 1 when no folder names one", () => {
    assert.equal(inferDiscLabel(track("Album/01.mp3")), "Disco 1");
    assert.equal(inferDiscLabel(track("Album/cd2.mp3")), "Disco 1");
    assert.equal(inferDiscLabel(track("Album/CDs/01.mp3")), "Disco 1");
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
