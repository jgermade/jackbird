import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { IPOD_DATABASES, folded, formatDriveSize, inGroups, ipodModel, ipodUsage, libraryCounts, usageParts, ipodCoverName, ipodSongMetadata, isSendable, likelyDuplicates, songKey } from "./ipod.ts";

describe("sending to an iPod", () => {
  it("folds names: case, accents, spaces and punctuation aside", () => {
    assert.equal(folded("Don’t Stop Me Now"), "dontstopmenow");
    assert.equal(folded("Mañana"), "manana");
    assert.equal(folded("Électrique!"), "electrique");
    assert.equal(folded("東京"), "東京");
    assert.equal(folded(" - "), "");
    assert.equal(songKey({ title: "Blue Eyes", artist: "Elton John" }), songKey({ title: "blue eyes", artist: "ELTON JOHN" }));
  });

  it("finds the songs the iPod has already", () => {
    const existing = [
      { title: "Self Esteem", artist: "The Offspring" },
      { title: "Blue Eyes", artist: "Elton John" }
    ];
    const candidates = [
      { title: "self esteem", artist: "the offspring" },
      { title: "Bad Habit", artist: "The Offspring" },
      { title: "Blue Eyes", artist: "Someone Else" },
      { title: "Blue  Eyes!", artist: "Elton John" }
    ];
    assert.deepEqual(likelyDuplicates(candidates, existing), [0, 3]);
  });

  it("finds one file sent twice, and never a song without a title", () => {
    const twice = [
      { title: "One", artist: "A" },
      { title: "one", artist: "a" },
      { title: "", artist: "A" },
      { title: "", artist: "A" }
    ];
    assert.deepEqual(likelyDuplicates(twice, [{ title: "", artist: "A" }]), [1]);
    assert.deepEqual(likelyDuplicates([], []), []);
  });

  it("sends MP3s only", () => {
    assert.equal(isSendable("Rock/Song.mp3"), true);
    assert.equal(isSendable("Rock/Song.MP3"), true);
    assert.equal(isSendable("Rock/Song.flac"), false);
    assert.equal(isSendable("Rock/mp3"), false);
  });
});

describe("an iPod in a browser", () => {
  it("looks for the compressed database first", () => {
    assert.deepEqual(IPOD_DATABASES, ["iPod_Control/iTunes/iTunesCDB", "iPod_Control/iTunes/iTunesDB"]);
  });

  it("names covers as the desktop app does", () => {
    // The names src-tauri/src/ipod.rs's cover_name gives (FNV-1a over the UTF-8, two seeds).
    assert.equal(ipodCoverName("/Volumes/NANO", 215), "d924c6d434529eaa-d7.png");
    assert.equal(ipodCoverName("NANO ñ", 215), "5882b531507a5007-d7.png");
    assert.notEqual(ipodCoverName("NANO", 1), ipodCoverName("NANO", 2));
  });

  it("gives a listed song's fields, its cover by reference", () => {
    const song = {
      title: "First song",
      artist: "The Fixtures",
      album: "Fixtures",
      albumArtist: "The Fixtures",
      genre: "Rock",
      year: "2024",
      trackNumber: "1/2",
      discNumber: "1/1",
      compilation: false
    };
    assert.deepEqual(ipodSongMetadata(song, "d924c6d434529eaa-64.png"), {
      title: "First song",
      artist: "The Fixtures",
      album: "Fixtures",
      year: "2024",
      genre: "Rock",
      trackNumber: "1/2",
      discNumber: "1/1",
      albumArtist: "The Fixtures",
      compilation: "",
      coverDataUrl: "jackbird-cover:d924c6d434529eaa-64.png"
    });
    const other = ipodSongMetadata({ ...song, compilation: true }, null);
    assert.equal(other.compilation, "1");
    assert.equal(other.coverDataUrl, null);
  });

  it("splits a list into groups", () => {
    assert.deepEqual(inGroups([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
    assert.deepEqual(inGroups([], 10), []);
    assert.deepEqual(inGroups([1, 2], 0), [[1], [2]]);
  });
});

describe("an iPod's foot and sheet", () => {
  it("tells the model from the family or the checksum", () => {
    assert.equal(ipodModel({ familyId: "18", checksum: 3 }), "nano7");
    assert.equal(ipodModel({ familyId: null, checksum: 3 }), "nano67");
    assert.equal(ipodModel({ familyId: "99", checksum: 2 }), "nano5");
    assert.equal(ipodModel({ familyId: null, checksum: 1 }), "hash58");
    assert.equal(ipodModel({ familyId: null, checksum: 0 }), "older");
    assert.equal(ipodModel({ familyId: null, checksum: null }), "unknown");
  });

  it("works out the space used", () => {
    assert.deepEqual(ipodUsage(1000, 250, 600), { total: 1000, free: 250, used: 750, fraction: 0.75, music: 600 });
    assert.deepEqual(ipodUsage(null, null, 600), { total: null, free: null, used: null, fraction: null, music: 600 });
    assert.deepEqual(ipodUsage(0, 0, 1), { total: null, free: null, used: null, fraction: null, music: 1 });
    assert.equal(ipodUsage(100, 200, 0).used, 0);
  });

  it("splits the used space by content", () => {
    const used = ipodUsage(1000, 200, 500);
    assert.deepEqual(usageParts(used, { artwork: 50, photos: 0, rockbox: 100 }), [
      { kind: "music", bytes: 500 },
      { kind: "covers", bytes: 50 },
      { kind: "rockbox", bytes: 100 },
      { kind: "other", bytes: 150 }
    ]);
    // What is known can be more than the system counts as used: no negative "other".
    assert.deepEqual(usageParts(ipodUsage(1000, 600, 500), { artwork: null, photos: null, rockbox: null }), [{ kind: "music", bytes: 500 }]);
    assert.deepEqual(usageParts(ipodUsage(null, null, 500), { artwork: 1, photos: 1, rockbox: 1 }), []);
  });

  it("counts songs, albums and artists", () => {
    const song = (album: string, artist: string, albumArtist = "", size = 10) => ({ size, metadata: { album, artist, albumArtist } });
    assert.deepEqual(
      libraryCounts([song("Fixtures", "The Fixtures"), song("fixtures", "The Fixtures"), song("Other", "Guest", "The Fixtures"), song("", ""), song("Fixtures", "Someone else")]),
      { songs: 5, albums: 3, artists: 3, bytes: 50 }
    );
    assert.deepEqual(libraryCounts([]), { songs: 0, albums: 0, artists: 0, bytes: 0 });
  });

  it("formats a drive's sizes as its system does", () => {
    assert.equal(formatDriveSize(15_803_000_000, "en"), "15.8 GB");
    assert.equal(formatDriveSize(15_803_000_000, "es"), "15,8 GB");
    assert.equal(formatDriveSize(980_000_000, "en"), "980 MB");
    assert.equal(formatDriveSize(1_500, "en"), "1.5 KB");
  });
});
