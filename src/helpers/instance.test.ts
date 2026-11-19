import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isHomeAddress, isLoopbackAddress, normaliseAddress, parseSaved, savedOnServer } from "./instance.ts";

describe("instance", () => {
  it("reads an address as typed", () => {
    assert.equal(normaliseAddress("music.example.org"), "https://music.example.org");
    assert.equal(normaliseAddress(" https://music.example.org/library/ "), "https://music.example.org");
    assert.equal(normaliseAddress("http://192.168.1.20:4646"), "http://192.168.1.20:4646");
    assert.equal(normaliseAddress("192.168.1.20:4646"), "https://192.168.1.20:4646");
  });

  it("refuses what is not an address", () => {
    assert.equal(normaliseAddress(""), null);
    assert.equal(normaliseAddress("   "), null);
    assert.equal(normaliseAddress("ftp://music.example.org"), null);
    assert.equal(normaliseAddress("https://"), null);
  });

  it("knows the device itself", () => {
    assert.ok(isLoopbackAddress("http://127.0.0.1:4646"));
    assert.ok(isLoopbackAddress("http://localhost:4646"));
    assert.ok(isLoopbackAddress("http://[::1]:4646"));
    assert.ok(!isLoopbackAddress("https://music.example.org"));
    assert.ok(!isLoopbackAddress("not an address"));
  });

  it("tells a home network's address", () => {
    for (const home of [
      "http://192.168.1.20:4646",
      "http://10.0.0.5:4646",
      "http://172.16.0.2",
      "http://172.31.255.1",
      "http://169.254.3.4",
      "http://localhost:4646",
      "http://[fd12:3456::1]:4646",
      "http://[fe80::1]:4646",
      "http://nas:4646",
      "http://music.local:4646",
      "http://music.lan",
      "http://music.home.arpa"
    ]) {
      assert.ok(isHomeAddress(home), home);
    }
    for (const away of ["https://music.example.org", "http://172.32.0.1", "http://8.8.8.8", "https://[2001:db8::1]", "not an address"]) {
      assert.ok(!isHomeAddress(away), away);
    }
  });

  it("keeps a server's roots with its address, and the home server's by their path alone", () => {
    assert.equal(savedOnServer(null, "/music"), "/music");
    const kept = savedOnServer("https://music.example.org", "/srv/music #1");
    assert.equal(kept, "jackbird-server:https://music.example.org#/srv/music #1");
    assert.deepEqual(parseSaved(kept), { server: "https://music.example.org", path: "/srv/music #1" });
    assert.deepEqual(parseSaved(savedOnServer("http://192.168.1.20:4646", "@library")), { server: "http://192.168.1.20:4646", path: "@library" });
    assert.deepEqual(parseSaved("/music"), { server: null, path: "/music" });
    assert.deepEqual(parseSaved("jackbird-server:no-path"), { server: null, path: "jackbird-server:no-path" });
  });
});
