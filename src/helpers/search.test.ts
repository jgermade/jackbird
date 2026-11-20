import assert from "node:assert/strict";
import { test } from "node:test";
import { foldText, queryWords, searchRank, searchSongs } from "./search.ts";

test("foldText: no capitals, accents, marks or punctuation", () => {
  assert.equal(foldText("Canción  Ñandú"), "cancion nandu");
  assert.equal(foldText("AC/DC — Back in Black!"), "ac dc back in black");
  assert.equal(foldText("Don't Stop"), "dont stop");
  assert.equal(foldText("Straße Œuvre Øresund Łódź đ Æon"), "strasse oeuvre oresund lodz d aeon");
  assert.equal(foldText("ｆｕｌｌ"), "full");
  assert.equal(foldText("  ¿?  "), "");
});

test("queryWords: the folded words, none for an empty query", () => {
  assert.deepEqual(queryWords(" Pink  FLOYD "), ["pink", "floyd"]);
  assert.deepEqual(queryWords("   "), []);
});

test("searchRank: every word somewhere, the title first", () => {
  const song = { title: "Wish You Were Here", artist: "Pink Floyd", album: "Wish You Were Here", name: "01 wish.flac" };
  assert.equal(searchRank(song, queryWords("wish you")), 3);
  assert.equal(searchRank(song, queryWords("were here")), 2);
  assert.equal(searchRank(song, queryWords("floyd wish")), 1);
  assert.equal(searchRank(song, queryWords("flac")), 1);
  assert.equal(searchRank(song, queryWords("floyd metallica")), 0);
  assert.equal(searchRank(song, []), 0);
});

test("searchRank: written together or apart", () => {
  const song = { title: "Thunderstruck", artist: "AC/DC" };
  assert.equal(searchRank(song, queryWords("acdc")), 1);
  assert.equal(searchRank(song, queryWords("ac dc")), 1);
  assert.equal(searchRank({ title: "Song", albumArtist: "Beyoncé" }, queryWords("beyonce")), 1);
});

test("searchSongs: best first, in the order given within each, at most the limit, with the count", () => {
  const songs = [
    { title: "Blackbird", artist: "Alter Bridge" },
    { title: "Rise Today", artist: "Alter Bridge", album: "Blackbird" },
    { title: "Blackbird", artist: "The Beatles" },
    { title: "The Blackbird Song" },
    { title: "Other" }
  ];
  const { found, total } = searchSongs(songs, "blackbird");
  assert.equal(total, 4);
  assert.deepEqual(found.map((song) => song.title), ["Blackbird", "Blackbird", "The Blackbird Song", "Rise Today"]);
  assert.deepEqual(searchSongs(songs, "blackbird", 2).found.length, 2);
  assert.equal(searchSongs(songs, "blackbird", 2).total, 4);
  assert.deepEqual(searchSongs(songs, "  "), { found: [], total: 0 });
});
