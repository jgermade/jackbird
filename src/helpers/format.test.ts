import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { audioLine, cleanTrackNumber, clockParts, dimmedLead, formatBytes, formatDuration, formatTime, formatTrackNumber, trackLead } from "./format.ts";

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

describe("cleanTrackNumber", () => {
  it("keeps the number alone, its total and the rest dropped", () => {
    assert.equal(cleanTrackNumber("2 de 6"), "2");
    assert.equal(cleanTrackNumber("2/6"), "2");
    assert.equal(cleanTrackNumber("2/"), "2");
    assert.equal(cleanTrackNumber(" 02 "), "2");
    assert.equal(cleanTrackNumber("A1"), "A1");
    assert.equal(cleanTrackNumber(""), "");
    assert.equal(cleanTrackNumber(undefined), "");
  });
});

describe("formatDuration", () => {
  it("gives minutes and seconds, hours past the hour, nothing when unknown", () => {
    assert.equal(formatDuration(197_000), "3:17");
    assert.equal(formatDuration(59_600), "1:00");
    assert.equal(formatDuration(3_723_000), "1:02:03");
    assert.equal(formatDuration(0), "");
    assert.equal(formatDuration(undefined), "");
  });
});

describe("audioLine", () => {
  it("says the format, the rates, the depth and the length, what is unknown left out", () => {
    assert.equal(audioLine({ durationMs: 197_000, bitrate: 320, sampleRate: 44_100, bits: 0, vbr: false }, "MP3", "es"), "MP3 · 320 kbps · 44,1 kHz · 3:17");
    assert.equal(audioLine({ durationMs: 197_000, bitrate: 245, sampleRate: 44_100, bits: 0, vbr: true }, "MP3", "en"), "MP3 · 245 kbps VBR · 44.1 kHz · 3:17");
    assert.equal(audioLine({ durationMs: 60_000, bitrate: 900, sampleRate: 48_000, bits: 24, vbr: true }, "FLAC", "en"), "FLAC · 900 kbps · 48 kHz · 24 bits · 1:00");
    assert.equal(audioLine({ durationMs: 60_000, bitrate: 256, sampleRate: 0, bits: 0, vbr: false }, "AAC", "en"), "AAC · 256 kbps · 1:00");
    assert.equal(audioLine(null, "MP3", "en"), "MP3");
  });
});
