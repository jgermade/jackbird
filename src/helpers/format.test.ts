import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatBytes, formatTime, formatTrackNumber } from "./format.ts";

describe("formatBytes", () => {
  it("writes zero as 0 Bytes", () => {
    assert.equal(formatBytes(0), "0 Bytes");
  });

  it("uses binary units with two decimals", () => {
    assert.equal(formatBytes(512), "512.00 Bytes");
    assert.equal(formatBytes(1536), "1.50 KB");
    assert.equal(formatBytes(9.5 * 1024 ** 2), "9.50 MB");
    assert.equal(formatBytes(2 * 1024 ** 3), "2.00 GB");
  });

  it("stays in GB above it and in Bytes below one", () => {
    assert.equal(formatBytes(3 * 1024 ** 4), "3072.00 GB");
    assert.equal(formatBytes(0.5), "0.50 Bytes");
  });
});

describe("formatTrackNumber", () => {
  it("is empty when there is no track number", () => {
    assert.equal(formatTrackNumber(undefined), "");
    assert.equal(formatTrackNumber(""), "");
  });

  it("drops the total and the spaces around it", () => {
    assert.equal(formatTrackNumber("03/12"), "03");
    assert.equal(formatTrackNumber(" 3 / 12 "), "3");
  });

  it("keeps a plain number as written", () => {
    assert.equal(formatTrackNumber(" 07 "), "07");
  });
});

describe("formatTime", () => {
  it("writes minutes and seconds, two digits each, dropping fractions", () => {
    assert.equal(formatTime(192.7), "03:12");
    assert.equal(formatTime(5), "00:05");
    assert.equal(formatTime(5999), "99:59");
  });

  it("goes past 99 minutes without wrapping", () => {
    assert.equal(formatTime(6000), "100:00");
  });

  it("is 00:00 for nothing, a negative or an unknown duration", () => {
    assert.equal(formatTime(0), "00:00");
    assert.equal(formatTime(-3), "00:00");
    assert.equal(formatTime(Number.NaN), "00:00");
    assert.equal(formatTime(Number.POSITIVE_INFINITY), "00:00");
  });
});
