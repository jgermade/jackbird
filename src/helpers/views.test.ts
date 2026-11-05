import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { track as fixture } from "./fixtures.test-support.ts";
import { albumFolder, albumKey, artistKey, buildViewRows, groupKeys } from "./views.ts";

const labels = { unknownArtist: "Unknown artist", unknownAlbum: "No album", variousArtists: "Various", missing: "Missing", locale: "en" };

const track = (relativePath: string, title: string, artist: string, album: string, trackNumber = "") => fixture(relativePath, { title, artist, album, trackNumber });

const tracks = [
  track("Miles/Kind of Blue/02.mp3", "Freddie Freeloader", "Miles Davis", "Kind of Blue", "2"),
  track("Miles/Kind of Blue/01.mp3", "So What", "Miles Davis", "Kind of Blue", "1"),
  track("Coltrane/Giant Steps/Disc 1/01.mp3", "Giant Steps", "John Coltrane", "Giant Steps", "1"),
  track("Coltrane/Giant Steps/Disc 2/01.mp3", "Naima", "John Coltrane", "Giant Steps", "1"),
  track("Mix/01.mp3", "One", "Ana", "Summer Mix", "1"),
  track("Mix/02.mp3", "Two", "Bea", "summer mix", "2"),
  track("Loose/x.mp3", "", "", "")
];

const labelsOf = (rows: { label: string }[]) => rows.map((row) => row.label);

describe("keys", () => {
  it("puts a Disc N or CD N folder's album in its parent", () => {
    assert.equal(albumFolder(tracks[2]), "Coltrane/Giant Steps");
    assert.equal(albumFolder({ relativePath: "A/CD2/x.mp3" }), "A");
    assert.equal(albumFolder({ relativePath: "x.mp3" }), "");
    assert.equal(albumKey(tracks[2]), albumKey(tracks[3]));
    assert.equal(albumKey(tracks[4]), albumKey(tracks[5]));
    assert.equal(artistKey(tracks[0]), "@artist:miles davis");
  });
});

describe("buildViewRows", () => {
  it("Songs: every track by title, its artist beside it", () => {
    const rows = buildViewRows("songs", tracks, [], labels);
    assert.deepEqual(labelsOf(rows), ["Freddie Freeloader", "Giant Steps", "Naima", "One", "So What", "Two", "x.mp3"]);
    assert.equal(rows[0].meta, "Miles Davis");
    assert.equal(rows[0].inView, "songs");
    assert.equal(rows[0].parentKey, null);
  });

  it("Artists: each artist, unknown last, opening into their tracks in play order", () => {
    const closed = buildViewRows("artists", tracks, [], labels);
    assert.deepEqual(labelsOf(closed), ["Ana", "Bea", "John Coltrane", "Miles Davis", "Unknown artist"]);
    assert.deepEqual(closed[3].trackIds, ["Miles/Kind of Blue/01.mp3", "Miles/Kind of Blue/02.mp3"]);
    const open = buildViewRows("artists", tracks, ["@artist:miles davis"], labels);
    assert.deepEqual(labelsOf(open).slice(3, 6), ["Miles Davis", "So What", "Freddie Freeloader"]);
    assert.equal(open[4].meta, "Kind of Blue");
    assert.equal(open[4].parentKey, "@artist:miles davis");
  });

  it("Albums: an album across its discs is one, an album of several artists says so", () => {
    const rows = buildViewRows("albums", tracks, "all", labels);
    const groups = rows.filter((row) => row.kind === "album");
    assert.deepEqual(labelsOf(groups), ["Giant Steps", "Kind of Blue", "Summer Mix", "No album"]);
    assert.deepEqual(groups.map((group) => group.meta), ["John Coltrane", "Miles Davis", "Various", "Unknown artist"]);
    assert.deepEqual(groups[0].trackIds, ["Coltrane/Giant Steps/Disc 1/01.mp3", "Coltrane/Giant Steps/Disc 2/01.mp3"]);
  });

  it("Compilations: only the albums with more than one artist", () => {
    const rows = buildViewRows("compilations", tracks, [], labels);
    assert.deepEqual(labelsOf(rows), ["Summer Mix"]);
  });

  it("Albums by artist: each artist, their albums, the tracks", () => {
    const rows = buildViewRows("albumsByArtist", tracks, "all", labels);
    const coltrane = rows.findIndex((row) => row.label === "John Coltrane");
    assert.deepEqual(labelsOf(rows.slice(coltrane, coltrane + 4)), ["John Coltrane", "Giant Steps", "Giant Steps", "Naima"]);
    assert.deepEqual(rows.slice(coltrane, coltrane + 4).map((row) => row.depth), [0, 1, 2, 2]);
    assert.equal(rows[coltrane + 1].parentKey, rows[coltrane].key);
  });

  it("Playlists: each one, opening into its entries in order, the missing ones marked", () => {
    const playlists = [
      { path: "Playlists/Road.m3u8", name: "Road", entries: [
        { path: "Mix/02.mp3", raw: "../Mix/02.mp3" },
        { path: null, raw: "http://example.com/x.mp3" },
        { path: "Gone/y.mp3", raw: "../Gone/y.mp3", title: "Gone - Y" },
        { path: "Mix/02.mp3", raw: "../Mix/02.mp3" }
      ] },
      { path: "A.m3u", name: "A", entries: [] }
    ];
    const rows = buildViewRows("playlists", tracks, ["@playlist:Playlists/Road.m3u8"], labels, playlists);
    assert.deepEqual(labelsOf(rows), ["A", "Road", "Two", "x.mp3", "Gone - Y", "Two"]);
    assert.deepEqual(rows[1].trackIds, ["Mix/02.mp3", "Mix/02.mp3"]);
    assert.equal(rows[1].meta, "4");
    assert.deepEqual(rows.slice(2).map((row) => [row.missing ?? false, row.playlistIndex, row.key]), [
      [false, 0, "@pl:Playlists/Road.m3u8#0"],
      [true, 1, "@pl:Playlists/Road.m3u8#1"],
      [true, 2, "@pl:Playlists/Road.m3u8#2"],
      [false, 3, "@pl:Playlists/Road.m3u8#3"]
    ]);
    assert.equal(rows[3].meta, "Missing");
  });
});

describe("groupKeys", () => {
  it("lists every group of a view, and none of Songs", () => {
    assert.deepEqual(groupKeys("compilations", tracks, labels), [albumKey(tracks[4])]);
    // Five artists, and one album each (the unknown artist's is "No album").
    assert.equal(groupKeys("albumsByArtist", tracks, labels).length, 5 + 5);
    assert.deepEqual(groupKeys("songs", tracks, labels), []);
  });
});
