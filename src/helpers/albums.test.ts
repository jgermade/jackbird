import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { groupAlbums } from "./albums.ts";
import { track } from "./fixtures.test-support.ts";

const kob = { artist: "Miles Davis", album: "Kind of Blue", year: "1959", genre: "Jazz", coverDataUrl: "data:kob" };

describe("groupAlbums", () => {
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
