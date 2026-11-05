import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { folderOf, indexFiles, matchPath, parseM3u, playlistName, relativePath, resolvePath, serializeM3u } from "./m3u.ts";

describe("paths", () => {
  it("names a playlist and its folder", () => {
    assert.equal(playlistName("Playlists/Road Trip.m3u8"), "Road Trip");
    assert.equal(playlistName("x.m3u"), "x");
    assert.equal(playlistName(".hidden"), ".hidden");
    assert.equal(folderOf("Playlists/Road Trip.m3u8"), "Playlists");
    assert.equal(folderOf("x.m3u"), "");
  });

  it("resolves a written path against the playlist's folder", () => {
    assert.equal(resolvePath("Playlists", "../Jazz/So What.mp3"), "Jazz/So What.mp3");
    assert.equal(resolvePath("", "Jazz\\So What.mp3"), "Jazz/So What.mp3");
    assert.equal(resolvePath("A/B", "./c/../d.mp3"), "A/B/d.mp3");
  });

  it("cannot resolve an absolute path, a URL, or one leaving the root", () => {
    assert.equal(resolvePath("Playlists", "/home/me/x.mp3"), null);
    assert.equal(resolvePath("Playlists", "C:\\Music\\x.mp3"), null);
    assert.equal(resolvePath("Playlists", "http://example.com/x.mp3"), null);
    assert.equal(resolvePath("Playlists", "file:///x.mp3"), null);
    assert.equal(resolvePath("Playlists", "../../x.mp3"), null);
    assert.equal(resolvePath("", ".."), null);
    assert.equal(resolvePath("", "  "), null);
  });

  it("writes a path relative to a folder", () => {
    assert.equal(relativePath("Playlists", "Jazz/So What.mp3"), "../Jazz/So What.mp3");
    assert.equal(relativePath("", "Jazz/So What.mp3"), "Jazz/So What.mp3");
    assert.equal(relativePath("Jazz", "Jazz/So What.mp3"), "So What.mp3");
    assert.equal(relativePath("A/B", "A/C/x.mp3"), "../C/x.mp3");
  });
});

describe("matchPath", () => {
  const files = indexFiles(["Jazz/So What.mp3", "Rock/So What.mp3", "So What.mp3", "Jazz/Kind of Blue/01.mp3", "Jazz/café.mp3"]);

  it("finds an absolute path's file by the longest tail that is one", () => {
    assert.equal(matchPath("/home/me/Music/Jazz/So What.mp3", files), "Jazz/So What.mp3");
    assert.equal(matchPath("/home/me/Music/So What.mp3", files), "So What.mp3");
    assert.equal(matchPath("C:\\Users\\me\\Music\\Jazz\\Kind of Blue\\01.mp3", files), "Jazz/Kind of Blue/01.mp3");
    assert.equal(matchPath("\\\\nas\\Music\\Rock\\So What.mp3", files), "Rock/So What.mp3");
  });

  it("reads a file: URL's escapes, and a relative path that leaves the root", () => {
    assert.equal(matchPath("file:///C:/Music/Jazz/caf%C3%A9.mp3", files), "Jazz/café.mp3");
    assert.equal(matchPath("file://localhost/home/me/Music/Jazz/So%20What.mp3", files), "Jazz/So What.mp3");
    assert.equal(matchPath("../../Music/Jazz/So What.mp3", files), "Jazz/So What.mp3");
  });

  it("prefers the same case, and finds none for a URL, a broken escape or an unknown file", () => {
    const cased = indexFiles(["a/X.mp3", "A/x.mp3"]);
    assert.equal(matchPath("/m/A/x.mp3", cased), "A/x.mp3");
    assert.equal(matchPath("http://example.com/Jazz/So What.mp3", files), null);
    assert.equal(matchPath("file:///Jazz/%E0%A4%A.mp3", files), null);
    assert.equal(matchPath("/home/me/Other.mp3", files), null);
    assert.equal(matchPath("/", files), null);
  });
});

describe("parseM3u", () => {
  it("reads entries, their #EXTINF, and skips the other directives", () => {
    const text = "\uFEFF#EXTM3U\r\n#PLAYLIST:Road\r\n#EXTINF:123,Miles Davis - So What\r\n../Jazz/So What.mp3\r\n\r\n#EXTGRP:x\r\nhttp://radio/stream\r\n../Gone.mp3\r\n";
    assert.deepEqual(parseM3u(text, "Playlists/Road.m3u8"), [
      { path: "Jazz/So What.mp3", raw: "../Jazz/So What.mp3", title: "Miles Davis - So What", duration: 123 },
      { path: null, raw: "http://radio/stream" },
      { path: "Gone.mp3", raw: "../Gone.mp3" }
    ]);
  });

  it("takes an unknown length, an empty title and old Mac line ends", () => {
    assert.deepEqual(parseM3u("#EXTINF:-1,\rA.mp3\r#EXTINF:5 tvg-id=\"x\",T\rB.mp3", ""), [
      { path: "A.mp3", raw: "A.mp3", title: undefined, duration: undefined },
      { path: "B.mp3", raw: "B.mp3", title: "T", duration: 5 }
    ]);
  });

  it("finds the root's file for a path written outside it, as VLC writes them", () => {
    const text = "#EXTM3U\n#EXTINF:545,Miles Davis - So What\n/home/me/Music/Jazz/So What.mp3\n/home/me/Elsewhere/y.mp3\n";
    assert.deepEqual(parseM3u(text, "Playlists/VLC.m3u", ["Jazz/So What.mp3"]), [
      { path: "Jazz/So What.mp3", raw: "/home/me/Music/Jazz/So What.mp3", title: "Miles Davis - So What", duration: 545 },
      { path: null, raw: "/home/me/Elsewhere/y.mp3" }
    ]);
  });

  it("reads a relative URL's escapes when that is a file of the root, and keeps an unknown path as written", () => {
    const text = "Jazz/So%20What.mp3\nJazz/100%25.mp3\nJazz/Gone%20.mp3\nJazz/%E0%A4%A.mp3\n";
    assert.deepEqual(parseM3u(text, "x.m3u", ["Jazz/So What.mp3", "Jazz/100%.mp3"]).map((entry) => entry.path), [
      "Jazz/So What.mp3",
      "Jazz/100%.mp3",
      "Jazz/Gone%20.mp3",
      "Jazz/%E0%A4%A.mp3"
    ]);
  });

  it("is empty for an empty file", () => {
    assert.deepEqual(parseM3u("", "x.m3u8"), []);
  });
});

describe("serializeM3u", () => {
  it("writes #EXTM3U, the #EXTINF of each entry and its path relative to the playlist", () => {
    const entries = [
      { path: "Jazz/So What.mp3", raw: "", title: "Miles Davis - So What" },
      { path: null, raw: "http://radio/stream" },
      { path: "Jazz/Blue.mp3", raw: "", title: "Blue", duration: 61.6 }
    ];
    assert.equal(serializeM3u(entries, "Playlists/Road.m3u8"), "#EXTM3U\n#EXTINF:-1,Miles Davis - So What\n../Jazz/So What.mp3\nhttp://radio/stream\n#EXTINF:62,Blue\n../Jazz/Blue.mp3\n");
  });

  it("reads back what it wrote", () => {
    const entries = [{ path: "Jazz/So What.mp3", raw: "../Jazz/So What.mp3", title: "So What", duration: 120 }];
    assert.deepEqual(parseM3u(serializeM3u(entries, "Playlists/Road.m3u8"), "Playlists/Road.m3u8"), entries);
  });
});
