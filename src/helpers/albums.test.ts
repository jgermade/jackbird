import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { groupAlbums, yearOrder } from "./albums.ts";
import { track } from "./fixtures.test-support.ts";

const kob = { artist: "Miles Davis", album: "Kind of Blue", year: "1959", genre: "Jazz", coverDataUrl: "data:kob" };

describe("groupAlbums", () => {
  it("groups by album artist, and keeps a compilation's tracks of many artists together", () => {
    const albums = groupAlbums(
      [
        track("m/01.mp3", { title: "One", artist: "Ana", album: "Mix", compilation: "1" }, "c1"),
        track("m/02.mp3", { title: "Two", artist: "Bea", album: "Mix", compilation: "1" }, "c2"),
        track("b/01.mp3", { title: "Live", artist: "Guest", albumArtist: "Band", album: "Live" }, "b1"),
        track("b/02.mp3", { title: "Encore", artist: "Band", album: "Live" }, "b2")
      ],
      "Untitled",
      "en"
    );
    assert.deepEqual(albums.map((album) => [album.title, album.discs[0].tracks.length]), [["Live", 2], ["Mix", 2]]);
    assert.equal(albums[0].artist, "Band");
  });

  it("groups by artist and album, ignoring case, taking the first track's details", () => {
    const albums = groupAlbums(
      [
        track("a/02.mp3", { ...kob, title: "Freddie", trackNumber: "2" }, "t2"),
        track("a/01.mp3", { ...kob, album: "kind of blue", year: "1960", title: "So What", trackNumber: "1" }, "t1")
      ],
      "No album",
      "en"
    );
    assert.equal(albums.length, 1);
    const [album] = albums;
    assert.equal(album.title, "Kind of Blue");
    assert.equal(album.artist, "Miles Davis");
    assert.equal(album.year, "1959");
    assert.equal(album.coverDataUrl, "data:kob");
    assert.deepEqual(album.discs.map((disc) => [disc.number, disc.tracks.map((one) => one.id)]), [[1, ["t1", "t2"]]]);
  });

  it("shows the first cover one of its tracks has, when the first track has none", () => {
    const albums = groupAlbums(
      [
        track("a/01.mp3", { ...kob, coverDataUrl: null, title: "So What" }, "t1"),
        track("a/02.mp3", { ...kob, title: "Freddie" }, "t2"),
        track("a/03.mp3", { ...kob, coverDataUrl: "data:other", title: "Blue" }, "t3")
      ],
      "No album",
      "en"
    );
    assert.equal(albums[0].coverDataUrl, "data:kob");
  });

  it("keeps two artists' albums of the same name apart", () => {
    const albums = groupAlbums([track("a.mp3", { artist: "A", album: "Greatest Hits" }), track("b.mp3", { artist: "B", album: "Greatest Hits" })], "No album", "en");
    assert.equal(albums.length, 2);
  });

  it("puts untagged tracks under the untitled name, sorted with the rest", () => {
    const albums = groupAlbums([track("x.mp3", {}), track("y.mp3", { album: "Abbey Road" })], "No album", "en");
    assert.deepEqual(albums.map((album) => album.title), ["Abbey Road", "No album"]);
  });

  it("orders discs by number and tracks by number, unnumbered last in arrival order", () => {
    const [album] = groupAlbums(
      [
        track("Album/CD2/01.mp3", { album: "Album", trackNumber: "1" }, "d2t1"),
        track("Album/CD1/x.mp3", { album: "Album" }, "d1x"),
        track("Album/CD1/y.mp3", { album: "Album" }, "d1y"),
        track("Album/CD1/03.mp3", { album: "Album", trackNumber: "3/12" }, "d1t3"),
        track("Album/CD1/01.mp3", { album: "Album", trackNumber: "1/12" }, "d1t1")
      ],
      "No album",
      "en"
    );
    assert.deepEqual(album.discs.map((disc) => [disc.number, disc.tracks.map((one) => one.id)]), [
      [1, ["d1t1", "d1t3", "d1x", "d1y"]],
      [2, ["d2t1"]]
    ]);
  });

  it("is empty for no tracks", () => {
    assert.deepEqual(groupAlbums([], "No album", "en"), []);
  });
});

describe("albums by year", () => {
  const one = (path: string, album: string, year: string) => track(path, { album, artist: "Miles Davis", year });
  const tracks = [
    one("a/1.mp3", "Kind of Blue", "1959"),
    one("b/1.mp3", "Bitches Brew", "1970-03-30"),
    one("c/1.mp3", "Birth of the Cool", ""),
    one("c/2.mp3", "Birth of the Cool", "1957"),
    one("d/1.mp3", "Aura", ""),
    one("e/1.mp3", "Miles Ahead", "1957")
  ];

  it("reads a year tag's place, oldest first, none last", () => {
    assert.equal(yearOrder("1959"), 1959);
    assert.equal(yearOrder("1970-03-30"), 1970);
    assert.ok(yearOrder("") > yearOrder("2999"));
    assert.ok(yearOrder(undefined) > yearOrder("2999"));
    assert.ok(yearOrder("unknown") > yearOrder("2999"));
  });

  it("sorts by year, then by title, when asked; by title otherwise", () => {
    assert.deepEqual(groupAlbums(tracks, "Untitled", "en", true).map((album) => album.title), ["Birth of the Cool", "Miles Ahead", "Kind of Blue", "Bitches Brew", "Aura"]);
    assert.deepEqual(groupAlbums(tracks, "Untitled", "en").map((album) => album.title), ["Aura", "Birth of the Cool", "Bitches Brew", "Kind of Blue", "Miles Ahead"]);
  });

  it("takes an album's first year among its tracks", () => {
    assert.equal(groupAlbums(tracks, "Untitled", "en").find((album) => album.title === "Birth of the Cool")?.year, "1957");
  });
});
