import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { IPOD_DATABASES, folded, inGroups, ipodCoverName, ipodSongMetadata, isSendable, likelyDuplicates, songKey } from "./ipod.ts";

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
