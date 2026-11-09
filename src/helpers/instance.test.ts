import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isLoopbackAddress, normaliseAddress } from "./instance.ts";

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
});
