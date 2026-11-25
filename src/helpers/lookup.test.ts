import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type { Track } from "../types.ts";
import { track } from "./fixtures.test-support.ts";
import {
  changedFields,
  coverArtUrl,
  coverWanted,
  discogsHeaders,
  discogsRelease,
  discogsReleaseUrl,
  discogsSearchUrl,
  isLookupId,
  discogsSearch,
  lookupPlan,
  lookupTerms,
  mergeCandidates,
  musicBrainzRelease,
  musicBrainzReleaseUrl,
  musicBrainzSearch,
  musicBrainzSearchUrl,
  pairTracks,
  paceOf,
  parseDiscogsPosition,
  parseDuration,
  scaledSize,
  scoreRelease,
  withChanges,
  type Release
} from "./lookup.ts";

const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`../../fixtures/lookup/${name}`, import.meta.url), "utf8"));

const file = (path: string, metadata: Partial<Track["metadata"]>, ms: number | null): Track => ({
  ...track(path, metadata),
  audio: ms === null ? null : ({ durationMs: ms } as Track["audio"])
});

// OK Computer's lengths as MusicBrainz gives them, a little off as files' are.
const okLengths = [287000, 384000, 267000, 264000, 299000, 264000, 117000, 230000, 285000, 228000, 259000, 324000];

describe("reading MusicBrainz", () => {
  it("reads a search's releases as summaries", () => {
    const releases = musicBrainzSearch(fixture("mb-search.json"));
    assert.equal(releases.length, 5);
    const first = releases[0];
    assert.deepEqual(
      { ...first, tracks: first.tracks.length },
      {
        source: "musicbrainz",
        id: "6a09041b-0f79-3278-88d9-0552dd28d37f",
        title: "OK Computer",
        artist: "Radiohead",
        year: "1997",
        country: "US",
        format: "CD",
        trackCount: 12,
        discCount: 1,
        genre: "",
        tracks: 0,
        releaseGroupId: "b1392450-e666-3926-a536-22c65f834433",
        artistId: "a74b1b7f-71a5-4011-9441-d0b5e4122711"
      }
    );
  });

  it("reads a release with its tracks, lengths, recordings and genre", () => {
    const release = musicBrainzRelease(fixture("mb-release.json"));
    assert.equal(release.title, "OK Computer");
    assert.equal(release.artist, "Radiohead");
    assert.equal(release.year, "1997");
    assert.equal(release.genre, "Alternative Rock");
    assert.equal(release.discCount, 1);
    assert.equal(release.tracks.length, 12);
    assert.deepEqual(release.tracks[1], {
      disc: 1,
      number: 2,
      title: "Paranoid Android",
      artist: "Radiohead",
      lengthMs: release.tracks[1].lengthMs,
      recordingId: release.tracks[1].recordingId,
      releaseTrackId: release.tracks[1].releaseTrackId
    });
    assert.ok(release.tracks.every((one) => one.lengthMs && one.recordingId && one.releaseTrackId && one.releaseTrackId !== one.recordingId));
  });

  it("joins an artist credit, numbers several discs and takes the group's genre and date", () => {
    const release = musicBrainzRelease({
      id: "r",
      title: "Duets",
      "artist-credit": [{ name: "Ann", joinphrase: " & " }, { name: "Bo", joinphrase: "", artist: { id: "ann" } }],
      "release-group": { id: "g", "first-release-date": "2001-02", genres: [{ name: "soul", count: 1 }, { name: "hip-hop", count: 4 }] },
      media: [
        { position: 1, format: "CD", tracks: [{ position: 1, title: "One", length: 1000 }] },
        { position: 2, format: "CD", tracks: [{ number: "1", title: "", recording: { title: "Two", length: 2000, "artist-credit": [{ name: "Guest" }] } }] },
        { format: "DVD", tracks: [{}] }
      ]
    });
    assert.equal(release.artist, "Ann & Bo");
    assert.equal(release.year, "2001");
    assert.equal(release.genre, "Hip-Hop");
    assert.equal(release.format, "2×CD + DVD");
    assert.equal(release.discCount, 3);
    assert.deepEqual(
      release.tracks.map((one) => [one.disc, one.number, one.title, one.artist, one.lengthMs]),
      [
        [1, 1, "One", "Ann & Bo", 1000],
        [2, 1, "Two", "Guest", 2000],
        [3, 1, "", "Ann & Bo", null]
      ]
    );
  });

  it("reads nothing out of an answer that is not one", () => {
    assert.deepEqual(musicBrainzSearch(null), []);
    assert.deepEqual(musicBrainzSearch({ releases: "no" }), []);
    const empty = musicBrainzRelease("nonsense");
    assert.equal(empty.tracks.length, 0);
    assert.equal(empty.discCount, 1);
  });
});

describe("reading Discogs", () => {
  it("reads a search's releases, the artist out of the title", () => {
    const releases = discogsSearch(fixture("dc-search.json"));
    assert.equal(releases.length, 5);
    const cd = releases.find((one) => one.id === "1475007");
    assert.deepEqual(cd && { ...cd, tracks: cd.tracks.length }, {
      source: "discogs",
      id: "1475007",
      title: "OK Computer",
      artist: "Radiohead",
      year: "2008",
      country: "Belgium",
      format: "CD, Album",
      trackCount: null,
      discCount: 1,
      genre: "Alternative Rock",
      tracks: 0
    });
  });

  it("reads a release with its tracks and lengths", () => {
    const release = discogsRelease(fixture("dc-release.json"));
    assert.equal(release.title, "OK Computer");
    assert.equal(release.artist, "Radiohead");
    assert.equal(release.year, "2008");
    assert.equal(release.genre, "Alternative Rock");
    assert.equal(release.format, "CD");
    assert.equal(release.tracks.length, 12);
    assert.deepEqual(release.tracks[0], { disc: 1, number: 1, title: "Airbag", artist: "Radiohead", lengthMs: 284000 });
    assert.equal(release.tracks[11].title, "The Tourist");
  });

  it("numbers a record's sides through, and several discs each from one", () => {
    const vinyl = discogsRelease({
      id: 1,
      title: "Sides",
      year: 1979,
      artists: [{ name: "Nirvana (2)", join: "&" }, { name: "Joe", anv: "Joey" }],
      formats: [{ name: "Vinyl", qty: "2" }],
      genres: ["Rock"],
      tracklist: [
        { position: "", type_: "heading", title: "Side one" },
        { position: "A1", title: "a", duration: "1:00" },
        { position: "A2", title: "b", duration: "" },
        { position: "B", title: "c", duration: "1:02:03", artists: [{ name: "Guest*" }] },
        { position: "Video", title: "not a track" }
      ]
    });
    assert.equal(vinyl.artist, "Nirvana & Joey");
    assert.equal(vinyl.year, "1979");
    assert.equal(vinyl.genre, "Rock");
    assert.equal(vinyl.format, "2×Vinyl");
    assert.deepEqual(
      vinyl.tracks.map((one) => [one.disc, one.number, one.title, one.artist, one.lengthMs]),
      [
        [1, 1, "a", "Nirvana & Joey", 60000],
        [1, 2, "b", "Nirvana & Joey", null],
        [1, 3, "c", "Guest", 3723000]
      ]
    );
    const discs = discogsRelease({ artists: [{ name: "A", join: "," }, { name: "B" }], tracklist: [{ position: "1-1" }, { position: "CD2-1" }, { position: "2.2" }] });
    assert.equal(discs.artist, "A, B");
    assert.equal(discs.discCount, 2);
    assert.equal(discs.year, "");
    assert.deepEqual(discs.tracks.map((one) => [one.disc, one.number]), [[1, 1], [2, 1], [2, 2]]);
  });

  it("reads a place and a length", () => {
    assert.deepEqual(parseDiscogsPosition("7"), { disc: 1, number: 7 });
    assert.deepEqual(parseDiscogsPosition("Disc 3 - 4"), { disc: 3, number: 4 });
    assert.deepEqual(parseDiscogsPosition("b2"), { disc: 1, side: "B", number: 2 });
    assert.equal(parseDiscogsPosition(""), null);
    assert.equal(parseDuration("4:44"), 284000);
    assert.equal(parseDuration("1:00:00"), 3600000);
    assert.equal(parseDuration("4m"), null);
  });

  it("leaves out what a search gives that is no release", () => {
    assert.deepEqual(discogsSearch({ results: [{ type: "master", id: 1, title: "X - Y" }] }), []);
    assert.deepEqual(discogsSearch({ results: [{ id: 2, title: "Untitled" }] }).map((one) => [one.artist, one.title, one.format, one.genre]), [["", "Untitled", "", ""]]);
  });
});

describe("pairing the files with a release's tracks", () => {
  const release = musicBrainzRelease(fixture("mb-release.json"));

  it("pairs by the files' numbers", () => {
    const files = release.tracks.map((one, at) => file(`OK/${at}.mp3`, { trackNumber: `${one.number}/12` }, okLengths[at]));
    const pairs = pairTracks(files, release);
    assert.ok(pairs.every((pair, at) => pair.by === "number" && pair.track === release.tracks[at]));
    assert.equal(scoreRelease(files, release), 1);
  });

  it("pairs by title, then by length, then not at all", () => {
    const files = [
      file("OK/x.mp3", { title: "karma police" }, null),
      file("OK/02 - Paranoid Android (Remastered).mp3", {}, null),
      file("OK/y.mp3", {}, okLengths[6]),
      file("OK/z.mp3", {}, 999999)
    ];
    const pairs = pairTracks(files, release);
    assert.deepEqual(pairs.map((pair) => [pair.by, pair.track?.title ?? null]), [
      ["title", "Karma Police"],
      ["title", "Paranoid Android"],
      ["length", "Fitter Happier"],
      [null, null]
    ]);
  });

  it("pairs by the files' order when nothing else tells, as many files as tracks", () => {
    const two: Pick<Release, "tracks"> = { tracks: [{ disc: 1, number: 1, title: "A", artist: "", lengthMs: null }, { disc: 1, number: 2, title: "B", artist: "", lengthMs: null }] };
    const files = [file("d/2.mp3", {}, null), file("d/1.mp3", {}, null)];
    assert.deepEqual(pairTracks(files, two).map((pair) => [pair.by, pair.track?.title]), [["order", "B"], ["order", "A"]]);
  });

  it("does not pair by numbers that repeat", () => {
    const files = [file("a.mp3", { trackNumber: "1", title: "Airbag" }, null), file("b.mp3", { trackNumber: "1", title: "Lucky" }, null)];
    assert.deepEqual(pairTracks(files, release).map((pair) => [pair.by, pair.track?.number]), [["title", 1], ["title", 11]]);
  });
});

describe("scoring a release", () => {
  const files = okLengths.map((ms, at) => file(`OK/${at}.mp3`, { trackNumber: String(at + 1) }, ms));

  it("judges a summary by its number of tracks", () => {
    const summary = musicBrainzSearch(fixture("mb-search.json"))[0];
    assert.equal(scoreRelease(files, summary), 1);
    assert.equal(scoreRelease(files.slice(0, 6), summary), 0.5);
    assert.equal(scoreRelease(files, { ...summary, trackCount: null }), 0.5);
  });

  it("weighs the lengths when it has its tracks", () => {
    const release = discogsRelease(fixture("dc-release.json"));
    const off = files.map((one, at) => (at < 6 ? one : file(one.relativePath, one.metadata, 1000)));
    assert.equal(scoreRelease(off, release), 0.7);
    const unknown = files.map((one) => file(one.relativePath, one.metadata, null));
    assert.equal(scoreRelease(unknown, release), 1);
  });
});

describe("the lookup's plan", () => {
  it("changes only what the release says otherwise", () => {
    const release = musicBrainzRelease(fixture("mb-release.json"));
    const files = [
      file("OK/01.mp3", { trackNumber: "1", title: "Airbag", artist: "Radiohead", album: "OK Computer", albumArtist: "Radiohead", year: "1997", genre: "Alternative Rock" }, okLengths[0]),
      file("OK/02.mp3", { trackNumber: "2", title: "paranoid android" }, okLengths[1]),
      file("OK/xx.mp3", { trackNumber: "40" }, null)
    ];
    const plans = lookupPlan(pairTracks(files, release), release);
    const text = (plan: (typeof plans)[number]) => plan.changes.filter((change) => !isLookupId(change.field));
    assert.deepEqual(text(plans[0]), [{ field: "trackNumber", from: "1", to: "1/12" }]);
    // The ids of a MusicBrainz release: its own, its group's, its artist's, the track's and the recording's.
    const ids = Object.fromEntries(plans[0].changes.filter((change) => isLookupId(change.field)).map((change) => [change.field, change.to]));
    assert.deepEqual(ids, {
      mbAlbumId: release.id,
      mbReleaseGroupId: release.releaseGroupId,
      mbAlbumArtistId: release.artistId,
      mbReleaseTrackId: release.tracks[0].releaseTrackId,
      mbRecordingId: release.tracks[0].recordingId
    });
    // An id the file has already is no change.
    const again = lookupPlan(pairTracks([file("OK/01.mp3", { ...files[0].metadata, trackNumber: "1/12", ...ids }, okLengths[0])], release), release);
    assert.deepEqual(again[0].changes, []);
    assert.deepEqual(text(plans[1]).map((change) => [change.field, change.to]), [
      ["title", "Paranoid Android"],
      ["artist", "Radiohead"],
      ["album", "OK Computer"],
      ["albumArtist", "Radiohead"],
      ["trackNumber", "2/12"],
      ["year", "1997"],
      ["genre", "Alternative Rock"]
    ]);
    assert.deepEqual(plans[2], { trackId: "OK/xx.mp3", track: null, changes: [] });
  });

  it("numbers the discs of a release of several", () => {
    const release: Release = {
      source: "discogs",
      id: "1",
      title: "Two",
      artist: "",
      year: "",
      country: "",
      format: "",
      trackCount: 3,
      discCount: 2,
      genre: "",
      tracks: [
        { disc: 1, number: 1, title: "a", artist: "", lengthMs: null },
        { disc: 2, number: 1, title: "b", artist: "", lengthMs: null },
        { disc: 2, number: 2, title: "c", artist: "", lengthMs: null }
      ]
    };
    const files = [file("x/b.mp3", { discNumber: "2", trackNumber: "1", title: "b" }, null)];
    assert.deepEqual(lookupPlan(pairTracks(files, release), release)[0].changes, [
      { field: "album", from: "", to: "Two" },
      { field: "trackNumber", from: "1", to: "1/2" },
      { field: "discNumber", from: "2", to: "2/2" },
      // A Discogs release: its id alone.
      { field: "discogsReleaseId", from: "", to: "1" }
    ]);
  });
});

describe("asking MusicBrainz", () => {
  it("searches by album and artist, quoted and escaped", () => {
    assert.equal(
      musicBrainzSearchUrl(' OK "Computer" ', "Radio\\head"),
      `https://musicbrainz.org/ws/2/release/?query=${encodeURIComponent('release:"OK \\"Computer\\"" AND artist:"Radio\\\\head"')}&fmt=json&limit=10`
    );
    assert.equal(musicBrainzSearchUrl("Album", "", 5), `https://musicbrainz.org/ws/2/release/?query=${encodeURIComponent('release:"Album"')}&fmt=json&limit=5`);
  });

  it("asks for a release with its recordings", () => {
    assert.equal(musicBrainzReleaseUrl("a b"), "https://musicbrainz.org/ws/2/release/a%20b?inc=recordings+artist-credits+release-groups+genres&fmt=json");
  });
});

describe("what to look up", () => {
  it("takes the album and the album artist the files share", () => {
    const files = [file("x/OK/1.mp3", { album: "OK Computer", artist: "Radiohead", albumArtist: "Radiohead" }, null), file("x/OK/2.mp3", { album: "OK Computer", artist: "Guest" }, null)];
    assert.deepEqual(lookupTerms(files), { album: "OK Computer", artist: "Radiohead" });
  });

  it("falls back on the folder's name, and on nothing where they differ", () => {
    const files = [file("x/Some Album/1.mp3", { artist: "A" }, null), file("x/Some Album/2.mp3", { artist: "B" }, null)];
    assert.deepEqual(lookupTerms(files), { album: "Some Album", artist: "" });
    assert.deepEqual(lookupTerms([file("a/1.mp3", {}, null), file("b/2.mp3", {}, null)]), { album: "", artist: "" });
  });
});

describe("applying the plan", () => {
  it("changes only the fields ticked, and lists the fields that change", () => {
    const before = file("a.mp3", { title: "old", year: "1990" }, null).metadata;
    const changes = [
      { field: "title" as const, from: "old", to: "New" },
      { field: "year" as const, from: "1990", to: "1997" }
    ];
    const after = withChanges(before, changes, ["year"]);
    assert.equal(after.title, "old");
    assert.equal(after.year, "1997");
    assert.equal(before.year, "1990");
    assert.deepEqual(changedFields([{ trackId: "a", track: null, changes: [changes[1], changes[0]] }, { trackId: "b", track: null, changes: [] }]), ["title", "year"]);
  });
});

describe("asking Discogs", () => {
  it("searches releases by title and artist", () => {
    assert.equal(discogsSearchUrl(" OK Computer ", "Radiohead"), "https://api.discogs.com/database/search?type=release&release_title=OK+Computer&artist=Radiohead&per_page=10");
    assert.equal(discogsSearchUrl("", "Björk", 5), "https://api.discogs.com/database/search?type=release&artist=Bj%C3%B6rk&per_page=5");
    assert.equal(discogsReleaseUrl("1475007"), "https://api.discogs.com/releases/1475007");
  });

  it("sends a token only when there is one", () => {
    assert.deepEqual(discogsHeaders(" abc "), { Authorization: "Discogs token=abc" });
    assert.deepEqual(discogsHeaders(""), {});
  });

  it("keeps each source's pace", () => {
    assert.equal(paceOf("musicbrainz"), 1100);
    assert.equal(paceOf("discogs"), 2450);
    assert.equal(paceOf("discogs", "abc"), 1050);
  });
});

describe("candidates of several sources", () => {
  it("puts the best fit first, and the sources in turn among equals", () => {
    const a = [{ id: "a1", fit: 50 }, { id: "a2", fit: 90 }];
    const b = [{ id: "b1", fit: 90 }, { id: "b2", fit: 10 }];
    assert.deepEqual(mergeCandidates([a, b]).map((one) => one.id), ["b1", "a2", "a1", "b2"]);
    assert.deepEqual(mergeCandidates([]), []);
  });
});

describe("a release's cover", () => {
  it("is the Cover Art Archive's front picture", () => {
    assert.equal(coverArtUrl("6a09041b"), "https://coverartarchive.org/release/6a09041b/front-1200");
    assert.equal(coverArtUrl("a b", 500), "https://coverartarchive.org/release/a%20b/front-500");
  });

  it("is offered ticked only where no file has one", () => {
    assert.equal(coverWanted([file("a.mp3", {}, null), file("b.mp3", {}, null)]), true);
    assert.equal(coverWanted([file("a.mp3", {}, null), file("b.mp3", { coverDataUrl: "jackbird-cover:x" }, null)]), false);
  });

  it("is scaled down to the editor's size, never up", () => {
    assert.deepEqual(scaledSize(1200, 1200, 1000), { width: 1000, height: 1000 });
    assert.deepEqual(scaledSize(1200, 600, 1000), { width: 1000, height: 500 });
    assert.deepEqual(scaledSize(500, 500, 1000), { width: 500, height: 500 });
  });
});
