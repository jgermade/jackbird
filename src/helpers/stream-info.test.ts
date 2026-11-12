import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { audioStart, kilohertz, streamInfo, streamInfoNeeds, streamQuality } from "./stream-info.ts";

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`../../fixtures/tags/${name}`, import.meta.url)));

/** Bytes from numbers and ASCII text, in order. */
function bytesOf(...parts: (number[] | string)[]): Uint8Array {
  return Uint8Array.from(parts.flatMap((part) => (typeof part === "string" ? [...part].map((char) => char.charCodeAt(0)) : part)));
}

const be32 = (value: number) => [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];

/** MPEG-1 layer III frames at 128 kbps, 44.1 kHz, stereo (417 bytes each), with `body` in the first. */
function mpeg1Frames(count: number, body: Uint8Array = new Uint8Array()): Uint8Array {
  const frame = new Uint8Array(417);
  frame.set([0xff, 0xfb, 0x90, 0x00]);
  const all = new Uint8Array(417 * count);
  for (let at = 0; at < count; at += 1) all.set(frame, at * 417);
  all.set(body, 4);
  return all;
}

describe("audioStart", () => {
  it("skips an ID3v2 tag, its footer too", () => {
    assert.equal(audioStart(bytesOf("ID3", [4, 0, 0, 0, 0, 1, 0])), 10 + 128);
    assert.equal(audioStart(bytesOf("ID3", [4, 0, 0x10, 0, 0, 0, 5])), 10 + 5 + 10);
    assert.equal(audioStart(bytesOf("fLaC")), 0);
    assert.equal(audioStart(bytesOf("ID3")), 0);
  });
  it("asks for the tag and some audio past it", () => {
    assert.equal(streamInfoNeeds(bytesOf("ID3", [3, 0, 0, 0, 0, 0, 100])), 110 + 8192);
    assert.equal(streamInfoNeeds(new Uint8Array(10)), 8192);
  });
});

describe("streamInfo", () => {
  it("reads a FLAC's depth, rate and channels from STREAMINFO", () => {
    assert.deepEqual(streamInfo(fixture("flac-full.flac")), { codec: "FLAC", rate: 8000, bits: 16, channels: 1 });
  });
  it("reads a FLAC with an ID3 tag in front", () => {
    assert.deepEqual(streamInfo(fixture("flac-id3-prefix.flac")), { codec: "FLAC", rate: 8000, bits: 16, channels: 1 });
  });
  it("reads a 24-bit, 96 kHz, stereo STREAMINFO", () => {
    // 96000 Hz = 0x17700 in 20 bits, then channels-1 = 1 in 3 bits, then bits-1 = 23 in 5 bits.
    const info = [0, 16, 16, 0, 0, 0, 0, 0, 0, 0, 0x17, 0x70, 0x03, 0x70, 0, 0, 0, 0];
    assert.deepEqual(streamInfo(bytesOf("fLaC", [0x80, 0, 0, 34], info)), { codec: "FLAC", rate: 96000, bits: 24, channels: 2 });
  });
  it("reads an MP3's bitrate and rate from its first frame, after its tag", () => {
    for (const name of ["mp3-no-tag.mp3", "mp3-v23-padded.mp3", "mp3-v24-footer.mp3"]) {
      assert.deepEqual(streamInfo(fixture(name)), { codec: "MP3", rate: 22050, kbps: 32, vbr: false, channels: 1 }, name);
    }
  });
  it("reads an MPEG-1 stereo frame, past junk before it", () => {
    const bytes = new Uint8Array(3 + 417 * 3);
    bytes.set([0xff, 0xfb, 0x00]); // a frame's start that is not one: a bitrate index of 0
    bytes.set(mpeg1Frames(3), 3);
    assert.deepEqual(streamInfo(bytes), { codec: "MP3", rate: 44100, kbps: 128, vbr: false, channels: 2 });
  });
  it("gives the mean bitrate of a VBR file from its Xing header", () => {
    // 100 frames of 1152 samples at 44.1 kHz is 2.612 s; 300000 bytes over it is 919 kbps.
    const xing = new Uint8Array(32 + 16);
    xing.set(bytesOf("Xing", be32(3), be32(100), be32(300000)), 32);
    assert.deepEqual(streamInfo(mpeg1Frames(2, xing)), { codec: "MP3", rate: 44100, kbps: 919, vbr: true, channels: 2 });
  });
  it("keeps the frame's bitrate when a Xing header has no counts, or is a CBR's Info", () => {
    const bare = new Uint8Array(32 + 8);
    bare.set(bytesOf("Xing", be32(0)), 32);
    assert.deepEqual(streamInfo(mpeg1Frames(2, bare)), { codec: "MP3", rate: 44100, kbps: 128, vbr: true, channels: 2 });
    const info = new Uint8Array(32 + 8);
    info.set(bytesOf("Info", be32(3)), 32);
    assert.deepEqual(streamInfo(mpeg1Frames(2, info)), { codec: "MP3", rate: 44100, kbps: 128, vbr: false, channels: 2 });
  });
  it("reads a VBRI header", () => {
    // VBRI at 36 from the frame: version, delay, quality (2 each), then the bytes and the frames.
    const vbri = new Uint8Array(32 + 18);
    vbri.set(bytesOf("VBRI", [0, 1, 0, 0, 0, 50], be32(150000), be32(100)), 32);
    assert.deepEqual(streamInfo(mpeg1Frames(2, vbri)), { codec: "MP3", rate: 44100, kbps: 459, vbr: true, channels: 2 });
  });
  it("is null for what is neither", () => {
    assert.equal(streamInfo(bytesOf("RIFF", new Array(64).fill(0))), null);
    assert.equal(streamInfo(new Uint8Array()), null);
    // A FLAC whose first block is not STREAMINFO, or is cut short.
    assert.equal(streamInfo(bytesOf("fLaC", [0x81, 0, 0, 34], new Array(18).fill(0))), null);
    assert.equal(streamInfo(bytesOf("fLaC", [0x80, 0, 0, 34], [0, 0])), null);
  });
});

describe("streamQuality", () => {
  it("writes a FLAC's depth and rate, an MP3's bitrate and rate", () => {
    assert.equal(streamQuality({ codec: "FLAC", rate: 96000, bits: 24, channels: 2 }), "24 bit · 96 kHz");
    assert.equal(streamQuality({ codec: "MP3", rate: 44100, kbps: 320, vbr: false, channels: 2 }), "320 kbps · 44.1 kHz");
    assert.equal(streamQuality({ codec: "MP3", rate: 48000, kbps: 245, vbr: true, channels: 2 }), "245 kbps · 48 kHz");
  });
  it("writes kHz with the decimals a rate has", () => {
    assert.equal(kilohertz(44100), "44.1");
    assert.equal(kilohertz(22050), "22.05");
    assert.equal(kilohertz(11025), "11.025");
    assert.equal(kilohertz(192000), "192");
  });
});
