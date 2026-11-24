import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { track as fixture } from "./fixtures.test-support.ts";
import { albumArtistOf, albumFolder, albumKey, artistKey, artistName, artistOfKey, buildViewRows, coverOfTracks, trackPlace, yearOfTracks } from "./views.ts";

const labels = { unknownArtist: "Unknown artist", unknownAlbum: "No album", variousArtists: "Various", missing: "Missing", liked: "Liked songs", allSongs: "All songs", locale: "en" };

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
    // An iPod's songs, spread over its music folders at random: grouped by their tags alone.
    assert.equal(albumFolder({ relativePath: "iPod_Control/Music/F24/STSM.mp3" }), "");
    assert.equal(albumFolder({ relativePath: "Rock/iPod_Control/Music/F24/STSM.mp3" }), "Rock/iPod_Control/Music/F24");
    assert.equal(albumKey(tracks[2]), albumKey(tracks[3]));
    assert.equal(albumKey(tracks[4]), albumKey(tracks[5]));
    assert.equal(artistKey(tracks[0]), "@artist:miles davis");
  });
});

describe("buildViewRows", () => {
  it("Lists: All songs first, every track by title, its artist and album beside it", () => {
    const closed = buildViewRows("playlists", tracks, [], labels);
    assert.deepEqual(labelsOf(closed), ["All songs"]);
    assert.equal(closed[0].allSongs, true);
    assert.equal(closed[0].meta, "7");
    const rows = buildViewRows("playlists", tracks, ["@all-songs"], labels);
    assert.deepEqual(labelsOf(rows).slice(1), ["Freddie Freeloader", "Giant Steps", "Naima", "One", "So What", "Two", "x.mp3"]);
    assert.deepEqual(rows[0].trackIds, rows.slice(1).map((row) => row.trackId));
    assert.equal(rows[1].meta, "Miles Davis - Kind of Blue");
    assert.equal(rows[7].meta, "");
    assert.equal(rows[1].inView, "playlists");
    assert.equal(rows[1].parentKey, "@all-songs");
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

  it("Compilations: also an album a track marks as one, and not one an album artist joins", () => {
    const marked = [...tracks, fixture("Hits/01.mp3", { title: "Hit", artist: "Solo", album: "Hits", compilation: "1" })];
    assert.deepEqual(labelsOf(buildViewRows("compilations", marked, [], labels)), ["Hits", "Summer Mix"]);
    const joined = tracks.map((one) => (one.metadata.album.toLowerCase() === "summer mix" ? { ...one, metadata: { ...one.metadata, albumArtist: "DJ Cee" } } : one));
    assert.deepEqual(labelsOf(buildViewRows("compilations", joined, [], labels)), []);
    assert.equal(buildViewRows("albums", joined, [], labels).find((row) => row.label === "Summer Mix")?.meta, "DJ Cee");
  });

  it("albumArtistOf: the album artist, else Various for a compilation, else the artist", () => {
    const one = fixture("a.mp3", { artist: "Ana" });
    assert.equal(albumArtistOf([one], "Various"), "Ana");
    assert.equal(albumArtistOf([{ ...one, metadata: { ...one.metadata, compilation: "1" } }], "Various"), "Various");
    assert.equal(albumArtistOf([one, { ...one, metadata: { ...one.metadata, albumArtist: "Band" } }], "Various"), "Band");
    assert.equal(albumArtistOf([], "Various"), "");
  });

  it("Albums by artist: a compilation under Various, its tracks together", () => {
    const rows = buildViewRows("albumsByArtist", tracks, "all", labels);
    const various = rows.findIndex((row) => row.label === "Various");
    const [artist, album, ...songs] = rows.slice(various, various + 4);
    assert.deepEqual([artist.depth, album.depth, album.label.toLowerCase()], [0, 1, "summer mix"]);
    assert.deepEqual(songs.map((song) => song.label).sort(), ["One", "Two"]);
  });

  it("Compilations: their rows as Albums draws them (the owner, 2026-11-16)", () => {
    const strip = (rows: ReturnType<typeof buildViewRows>) => rows.map(({ inView, ...row }) => row);
    const compilations = buildViewRows("compilations", tracks, "all", labels);
    const albums = buildViewRows("albums", tracks, "all", labels).filter((row) => compilations.some((one) => one.key === row.key));
    assert.ok(compilations.length > 0);
    assert.deepEqual(strip(compilations), strip(albums));
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
    assert.deepEqual(labelsOf(rows), ["All songs", "A", "Road", "Two", "x.mp3", "Gone - Y", "Two"]);
    assert.deepEqual(rows[2].trackIds, ["Mix/02.mp3", "Mix/02.mp3"]);
    assert.equal(rows[2].meta, "4");
    assert.deepEqual(rows.slice(3).map((row) => [row.missing ?? false, row.playlistIndex, row.key]), [
      [false, 0, "@pl:Playlists/Road.m3u8#0"],
      [true, 1, "@pl:Playlists/Road.m3u8#1"],
      [true, 2, "@pl:Playlists/Road.m3u8#2"],
      [false, 3, "@pl:Playlists/Road.m3u8#3"]
    ]);
    assert.equal(rows[4].meta, "Missing");
  });

  it("Playlists: the liked songs first, by their translated name, marked", () => {
    const playlists = [
      { path: "A.m3u", name: "A", entries: [] },
      { path: "Liked.m3u8", name: "Liked", entries: [{ path: "Mix/02.mp3", raw: "Mix/02.mp3" }] }
    ];
    const rows = buildViewRows("playlists", tracks, [], labels, playlists);
    assert.deepEqual(labelsOf(rows), ["All songs", "Liked songs", "A"]);
    assert.deepEqual(rows.map((row) => row.liked ?? false), [false, true, false]);
    assert.equal(rows[1].meta, "1");
  });
});

describe("an album's row: its cover, and who it is by and its year", () => {
  const covered = [
    fixture("Miles/Kind of Blue/01.mp3", { title: "So What", artist: "Miles Davis", album: "Kind of Blue", year: "1959-08-17" }),
    fixture("Miles/Kind of Blue/02.mp3", { title: "Freddie", artist: "Miles Davis", album: "Kind of Blue", coverDataUrl: "jackbird-cover:kob.jpg" }),
    fixture("Trane/Giant Steps/01.mp3", { title: "Giant Steps", artist: "John Coltrane", album: "Giant Steps" })
  ];

  it("takes the first track's cover that has one, and a date's year", () => {
    assert.equal(coverOfTracks(covered.slice(0, 2)), "jackbird-cover:kob.jpg");
    assert.equal(coverOfTracks(covered.slice(2)), undefined);
    assert.equal(yearOfTracks(covered), "1959");
    assert.equal(yearOfTracks([fixture("a.mp3", { year: "circa 70s" })]), "circa 70s");
  });

  it("gives Albums' rows their cover and a line of their artist; none without them", () => {
    const rows = buildViewRows("albums", covered, [], labels);
    const blue = rows.find((row) => row.label === "Kind of Blue");
    const steps = rows.find((row) => row.label === "Giant Steps");
    assert.equal(blue?.cover, "jackbird-cover:kob.jpg");
    assert.equal(blue?.sub, "Miles Davis");
    assert.equal(blue?.meta, "Miles Davis");
    assert.equal(steps?.cover, undefined);
    assert.equal(steps?.sub, "John Coltrane");
    // Both with a cover's room, so their names line up.
    assert.equal(blue?.framed, true);
    assert.equal(steps?.framed, true);
  });

  it("in Albums by artist, an album's line is its year alone, its artist the row above", () => {
    const rows = buildViewRows("albumsByArtist", covered, "all", labels);
    const blue = rows.find((row) => row.label === "Kind of Blue");
    assert.equal(blue?.sub, "1959");
    assert.equal(blue?.cover, "jackbird-cover:kob.jpg");
    // The artist's row: their first album's cover, with no picture of their own.
    assert.equal(rows.find((row) => row.label === "Miles Davis")?.cover, "jackbird-cover:kob.jpg");
    // Its tracks: their title alone.
    assert.ok(rows.filter((row) => row.kind === "track").every((row) => !row.sub && !row.cover));
  });

  it("gives All songs' songs their album's cover and a line of artist and album; Artists' tracks the same line", () => {
    const songs = buildViewRows("playlists", covered, ["@all-songs"], labels).slice(1);
    const freddie = songs.find((row) => row.label === "Freddie");
    assert.equal(freddie?.cover, "jackbird-cover:kob.jpg");
    assert.equal(freddie?.sub, "Miles Davis - Kind of Blue");
    assert.ok(songs.every((row) => row.framed));
    const artists = buildViewRows("artists", covered, "all", labels);
    assert.equal(artists.find((row) => row.label === "Freddie")?.sub, "Miles Davis - Kind of Blue");
    assert.equal(artists.find((row) => row.label === "Freddie")?.cover, undefined);
  });
});

describe("trackPlace", () => {
  it("names a track's row and the rows to open above it, the outermost first", () => {
    const rows = buildViewRows("albumsByArtist", tracks, "all", labels);
    const id = tracks.find((one) => one.metadata.title === "So What")!.id;
    const place = trackPlace(rows, id);
    assert.equal(place?.key, `track:${id}`);
    assert.equal(place?.open.length, 2);
    assert.ok(place?.open[0].startsWith("@artist:"));
    assert.ok(place?.open[1].startsWith("@aba:"));
  });

  it("is null where the list has no row of it", () => {
    assert.equal(trackPlace(buildViewRows("artists", tracks, [], labels), tracks[0].id), null);
    // In the lists, a song is in All songs.
    assert.deepEqual(trackPlace(buildViewRows("playlists", tracks, "all", labels), tracks[0].id)?.open, ["@all-songs"]);
  });
});

describe("an artist's picture in the rows", () => {
  const two = [
    fixture("a/1.mp3", { title: "One", artist: "Fugazi", album: "Repeater" }),
    fixture("b/1.mp3", { title: "Two", artist: "  Bad Brains ", album: "Rock for Light" })
  ];

  it("keeps a picture by the artist's name without case, and reads it back from a group's key", () => {
    assert.equal(artistName("  Bad Brains "), "bad brains");
    assert.equal(artistOfKey("@artist:fugazi"), "fugazi");
    assert.equal(artistOfKey("@album:x::y"), null);
  });

  it("gives artist rows their picture, round, all of them a picture's room when one has one", () => {
    const rows = buildViewRows("artists", two, [], labels, [], { fugazi: "jackbird-cover:f.jpg" });
    const fugazi = rows.find((row) => row.label === "Fugazi");
    const bad = rows.find((row) => row.label === "Bad Brains");
    assert.equal(fugazi?.cover, "jackbird-cover:f.jpg");
    assert.equal(fugazi?.round, true);
    assert.equal(bad?.cover, undefined);
    assert.equal(bad?.framed, true);
    assert.equal(bad?.round, true);
  });

  it("does the same in Albums by artist, and keeps the room where no artist has a picture", () => {
    const rows = buildViewRows("albumsByArtist", two, [], labels, [], { "bad brains": "jackbird-cover:b.jpg" });
    assert.equal(rows.find((row) => row.label === "Bad Brains")?.cover, "jackbird-cover:b.jpg");
    const none = buildViewRows("artists", two, [], labels);
    assert.ok(none.every((row) => row.framed && row.round && !row.cover));
  });
});
