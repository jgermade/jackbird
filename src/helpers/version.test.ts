import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isNewerVersion } from "./version.ts";

describe("isNewerVersion", () => {
  it("compares each part as a number", () => {
    assert.equal(isNewerVersion("0.1.10", "0.1.9"), true);
    assert.equal(isNewerVersion("0.2.0", "0.1.99"), true);
    assert.equal(isNewerVersion("1.0.0", "0.9.9"), true);
    assert.equal(isNewerVersion("0.1.8", "0.1.8"), false);
    assert.equal(isNewerVersion("0.1.7", "0.1.8"), false);
  });

  it("reads a leading v, and missing or odd parts as 0", () => {
    assert.equal(isNewerVersion("v0.1.9", "0.1.8"), true);
    assert.equal(isNewerVersion("0.2", "0.1.9"), true);
    assert.equal(isNewerVersion("0.1.8-beta", "0.1.8"), false);
    assert.equal(isNewerVersion("x", "0.0.0"), false);
  });

  it("is false when either is missing", () => {
    assert.equal(isNewerVersion(null, "0.1.8"), false);
    assert.equal(isNewerVersion("0.1.9", undefined), false);
    assert.equal(isNewerVersion("", ""), false);
  });
});
