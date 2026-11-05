import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { track } from "./fixtures.test-support.ts";
import { parseM3u, serializeM3u } from "./m3u.ts";
import { decodePlaylist, entryFor, isPlaylistFile, moveEntry, newPlaylistPath, pathTaken, renamedEntries, withoutEntry, withPlaylist } from "./playlists.ts";

const a = { path: "A.mp3", raw: "A.mp3" };
const b = { path: "B.mp3", raw: "B.mp3", title: "B" };
const c = { path: null, raw: "http://radio/c" };

describe("files", () => {
  it("knows a playlist by its extension", () => {
    assert.equal(isPlaylistFile("Playlists/Road.m3u8"), true);
    assert.equal(isPlaylistFile("OLD.M3U"), true);
    assert.equal(isPlaylistFile("song.mp3"), false);
    assert.equal(isPlaylistFile("notes.m3u.txt"), false);
  });

  it("reads .m3u8 as UTF-8, and .m3u as UTF-8 or else Windows-1252", () => {
    const utf8 = new TextEncoder().encode("Café.mp3\n");
    assert.equal(decodePlaylist(utf8, "x.m3u8"), "Café.mp3\n");
    assert.equal(decodePlaylist(utf8, "x.m3u"), "Café.mp3\n");
    assert.equal(decodePlaylist(new Uint8Array([0x43, 0x61, 0x66, 0xe9]), "x.m3u"), "Café");
  });

  it("puts a new playlist in Playlists/, its name made safe, and none for an empty name", () => {
    assert.equal(newPlaylistPath(" Road: Trip "), "Playlists/Road_ Trip.m3u8");
    assert.equal(newPlaylistPath("  ..  "), null);
    assert.equal(pathTaken("Playlists/road.m3u8", ["Playlists/Road.m3u8"]), true);
    assert.equal(pathTaken("Playlists/Road 2.m3u8", ["Playlists/Road.m3u8"]), false);
  });
});

describe("entries", () => {
  it("gives a track's path, and Artist - Title, or the title, or nothing", () => {
    assert.deepEqual(entryFor(track("Jazz/x.mp3", { title: "So What", artist: "Miles Davis" })), { path: "Jazz/x.mp3", raw: "Jazz/x.mp3", title: "Miles Davis - So What" });
    assert.equal(entryFor(track("x.mp3", { title: "So What" })).title, "So What");
    assert.equal(entryFor(track("x.mp3", { artist: "Miles Davis" })).title, undefined);
  });

  it("moves an entry, and leaves them as they were when out of range", () => {
    assert.deepEqual(moveEntry([a, b, c], 0, 2), [b, c, a]);
    assert.deepEqual(moveEntry([a, b, c], 2, 0), [c, a, b]);
    assert.deepEqual(moveEntry([a, b, c], 0, 3), [a, b, c]);
    assert.deepEqual(moveEntry([a, b, c], -1, 0), [a, b, c]);
    assert.deepEqual(moveEntry([a, b, c], 1, 1), [a, b, c]);
  });

  it("takes one out by its place, a duplicate staying", () => {
    assert.deepEqual(withoutEntry([a, b, a], 2), [a, b]);
  });

  it("follows renamed files, and says when none was", () => {
    const renames = new Map([["A.mp3", "Jazz/A.mp3"]]);
    assert.deepEqual(renamedEntries([a, b, c, a], renames), [{ path: "Jazz/A.mp3", raw: "Jazz/A.mp3" }, b, c, { path: "Jazz/A.mp3", raw: "Jazz/A.mp3" }]);
    assert.equal(renamedEntries([b, c], renames), null);
  });

  it("writes a track's entry as other players read it", () => {
    const entries = [entryFor(track("Jazz/So What.mp3", { title: "So What", artist: "Miles Davis" }))];
    assert.equal(serializeM3u(entries, "Playlists/Road.m3u8"), "#EXTM3U\n#EXTINF:-1,Miles Davis - So What\n../Jazz/So What.mp3\n");
    assert.deepEqual(parseM3u(serializeM3u(entries, "Playlists/Road.m3u8"), "Playlists/Road.m3u8"), [
      { path: "Jazz/So What.mp3", raw: "../Jazz/So What.mp3", title: "Miles Davis - So What", duration: undefined }
    ]);
  });
});

describe("withPlaylist", () => {
  it("replaces the playlist at its path, or adds it", () => {
    const road = { path: "Playlists/Road.m3u8", name: "Road", entries: [a] };
    const other = { path: "x.m3u", name: "x", entries: [] };
    assert.deepEqual(withPlaylist([road, other], { ...road, entries: [b] }), [{ ...road, entries: [b] }, other]);
    assert.deepEqual(withPlaylist([other], road), [other, road]);
  });
});
