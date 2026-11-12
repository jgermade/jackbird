import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { clockParts, dimmedLead, formatBytes, formatTime, formatTrackNumber, trackLead } from "./format.ts";

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

describe("dimmedLead", () => {
  it("dims the leading zeros but the last digit", () => {
    assert.equal(dimmedLead("03"), "0");
    assert.equal(dimmedLead("003"), "00");
    assert.equal(dimmedLead("12"), "");
    assert.equal(dimmedLead("10"), "");
  });
  it("dims every digit when all are zeros", () => {
    assert.equal(dimmedLead("00"), "00");
    assert.equal(dimmedLead("0"), "0");
  });
  it("gives nothing for no digits", () => {
    assert.equal(dimmedLead(""), "");
  });
});

describe("clockParts", () => {
  it("splits a time into dimmed zeros, lit minutes and seconds", () => {
    assert.deepEqual(clockParts(192.7), { lead: "0", minutes: "3", seconds: "12" });
    assert.deepEqual(clockParts(5), { lead: "00", minutes: "", seconds: "05" });
    assert.deepEqual(clockParts(754), { lead: "", minutes: "12", seconds: "34" });
    assert.deepEqual(clockParts(6000), { lead: "", minutes: "100", seconds: "00" });
  });
  it("shows 0 for a time below zero or not known", () => {
    assert.deepEqual(clockParts(-3), { lead: "00", minutes: "", seconds: "00" });
    assert.deepEqual(clockParts(Number.NaN), { lead: "00", minutes: "", seconds: "00" });
    assert.deepEqual(clockParts(Number.POSITIVE_INFINITY), { lead: "00", minutes: "", seconds: "00" });
  });
});

describe("trackLead", () => {
  it("shows a track's number, without its total", () => {
    assert.equal(trackLead("03/12", false, true), "03");
    assert.equal(trackLead("7", true, false), "7");
  });
  it("shows … for a number not read yet", () => {
    assert.equal(trackLead(undefined, true, false), "…");
  });
  it("leaves a blank as wide as a number when others have one, and nothing when none has", () => {
    assert.equal(trackLead(undefined, false, true), "\u00a0");
    assert.equal(trackLead(" ", false, true), "\u00a0");
    assert.equal(trackLead(undefined, false, false), "");
  });
});
