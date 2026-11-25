import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Track } from "../types.ts";
import { track } from "./fixtures.test-support.ts";
import { ALL_SONGS_KEY, listCards, playlistKey, songsByTitle, sortedPlaylists } from "./lists.ts";

const labels = { allSongs: "All songs", liked: "Liked songs", locale: "en" };

const timed = (path: string, title: string, artist: string, album: string, ms: number, cover: string | null = null): Track => ({
  ...track(path, { title, artist, album, coverDataUrl: cover }),
  audio: { durationMs: ms } as Track["audio"]
});
const b = timed("B/b.mp3", "Beta", "Bea", "Two", 2000, "cover-b");
const a = timed("A/a.mp3", "Alpha", "Ana", "", 1000);
const z: Track = track("Z/z.mp3");
const tracks = [b, a, z];

const playlists = [
  { path: "Road.m3u8", name: "Road", entries: [
    { path: "A/a.mp3", raw: "A/a.mp3" },
    { path: null, raw: "http://example.com/far/away.mp3" },
    { path: "Gone/g.mp3", raw: "Gone/g.mp3", title: "Gone - G" },
    { path: "B/b.mp3", raw: "B/b.mp3" }
  ] },
  { path: "Liked.m3u8", name: "Liked", entries: [{ path: "B/b.mp3", raw: "B/b.mp3" }] },
  { path: "Calm.m3u8", name: "Calm", entries: [] }
];

describe("the lists' order", () => {
  it("lists every song by title, then by path", () => {
    assert.deepEqual(songsByTitle(tracks, "en").map((one) => one.id), ["A/a.mp3", "B/b.mp3", "Z/z.mp3"]);
  });

  it("puts the liked songs first, the others by name", () => {
    assert.deepEqual(sortedPlaylists(playlists, "en").map((one) => one.name), ["Liked", "Calm", "Road"]);
  });
});

describe("listCards", () => {
  it("makes a card of All songs, the liked songs and each playlist, in that order", () => {
    const cards = listCards(tracks, playlists, labels);
    assert.deepEqual(cards.map((card) => [card.key, card.name, card.kind, card.path ?? null]), [
      [ALL_SONGS_KEY, "All songs", "all", null],
      [playlistKey("Liked.m3u8"), "Liked songs", "liked", "Liked.m3u8"],
      [playlistKey("Calm.m3u8"), "Calm", "playlist", "Calm.m3u8"],
      [playlistKey("Road.m3u8"), "Road", "playlist", "Road.m3u8"]
    ]);
  });

  it("gives a card its songs in order, the missing ones marked, what plays and how long", () => {
    const road = listCards(tracks, playlists, labels).find((card) => card.name === "Road");
    assert.deepEqual(road?.entries, [
      { key: "A/a.mp3", index: 0, trackId: "A/a.mp3", title: "Alpha", sub: "Ana", missing: false },
      { key: "#1", index: 1, title: "away.mp3", sub: "", missing: true },
      { key: "#2", index: 2, title: "Gone - G", sub: "", missing: true },
      { key: "B/b.mp3", index: 3, trackId: "B/b.mp3", title: "Beta", sub: "Bea - Two", cover: "cover-b", missing: false }
    ]);
    assert.deepEqual(road?.trackIds, ["A/a.mp3", "B/b.mp3"]);
    assert.equal(road?.durationMs, 3000);
    const all = listCards(tracks, playlists, labels)[0];
    assert.deepEqual(all.trackIds, ["A/a.mp3", "B/b.mp3", "Z/z.mp3"]);
    assert.equal(all.entries[2].title, "z.mp3");
    assert.equal(all.durationMs, 3000);
    const calm = listCards(tracks, playlists, labels).find((card) => card.name === "Calm");
    assert.equal(calm?.durationMs, 0);
  });

  it("shows only the list chosen, or all of them for one it does not know", () => {
    assert.deepEqual(listCards(tracks, playlists, labels, playlistKey("Road.m3u8")).map((card) => card.name), ["Road"]);
    assert.deepEqual(listCards(tracks, playlists, labels, ALL_SONGS_KEY).map((card) => card.name), ["All songs"]);
    assert.equal(listCards(tracks, playlists, labels, "@playlist:Gone.m3u8").length, 4);
  });
});
