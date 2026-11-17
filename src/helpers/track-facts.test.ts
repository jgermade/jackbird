import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { track } from "./fixtures.test-support.ts";
import { allFacts, trackFacts } from "./track-facts.ts";

// The key itself as its text: what is asked for shows in the result.
const t = (key: string): string => key;
const textOf = (facts: { label: string; text: string }[], label: string) => facts.find((fact) => fact.label === label)?.text;

describe("trackFacts", () => {
  const song = {
    ...track("Jazz/Kind of Blue/01 So What.flac", { title: "So What", artist: "Miles Davis", compilation: "1" }),
    size: 2048,
    fullChecksum: "full",
    audioChecksum: "audio",
    lastVerifiedAt: "2026-11-17T03:00:00.000Z",
    audio: { durationMs: 545000, bitrate: 900, sampleRate: 44100, channels: 2, bits: 16, vbr: true }
  };

  it("gives its quality", () => {
    const { quality } = trackFacts(song, t, "en");
    assert.equal(textOf(quality, "info.format"), "FLAC");
    assert.equal(textOf(quality, "info.duration"), "9:05");
    // A lossless file's bitrate always varies: no VBR said for it.
    assert.equal(textOf(quality, "info.bitrate"), "900 kbps");
    assert.equal(textOf(quality, "info.sampleRate"), "44.1 kHz");
    assert.equal(textOf(quality, "info.channels"), "info.stereo");
    assert.equal(textOf(quality, "info.bits"), "16 bits");
  });

  it("gives its tags, where it is and its file", () => {
    const facts = trackFacts(song, t, "en");
    assert.equal(textOf(facts.tags, "field.title"), "So What");
    assert.equal(textOf(facts.tags, "field.compilation"), "common.yes");
    assert.equal(textOf(facts.tags, "field.year"), "common.none");
    assert.equal(facts.tags.find((fact) => fact.label === "field.lyrics")?.long, true);
    assert.deepEqual(facts.where[0], { label: "info.relativePath", text: "Jazz/Kind of Blue/01 So What.flac", mono: true });
    assert.equal(textOf(facts.file, "info.fullChecksum"), "full");
    assert.equal(textOf(facts.file, "info.audioChecksum"), "audio");
    assert.notEqual(textOf(facts.file, "info.lastVerified"), "common.none");
  });

  it("says what is not known, and an MP3's varying bitrate", () => {
    const bare = { ...track("a.mp3"), size: 0, checksum: "", audio: null };
    const facts = trackFacts(bare, t, "en");
    for (const label of ["info.duration", "info.bitrate", "info.sampleRate", "info.channels"]) assert.equal(textOf(facts.quality, label), "common.none");
    assert.equal(textOf(facts.quality, "info.bits"), undefined);
    assert.equal(textOf(facts.tags, "field.compilation"), "common.no");
    assert.equal(textOf(facts.file, "info.fullChecksum"), "common.none");
    assert.equal(textOf(facts.file, "info.lastVerified"), "common.none");
    const vbr = { ...bare, audio: { durationMs: 1000, bitrate: 190, sampleRate: 48000, channels: 1, bits: 0, vbr: true } };
    const quality = trackFacts(vbr, t, "en").quality;
    assert.equal(textOf(quality, "info.bitrate"), "190 kbps (VBR)");
    assert.equal(textOf(quality, "info.channels"), "info.mono");
    const surround = { ...vbr, audio: { ...vbr.audio, channels: 6 } };
    assert.equal(textOf(trackFacts(surround, t, "en").quality, "info.channels"), "6");
  });

  it("lists them all in the selection dialog's order", () => {
    const facts = trackFacts(song, t, "en");
    const all = allFacts(facts);
    assert.equal(all.length, facts.tags.length + facts.where.length + facts.quality.length + facts.file.length);
    assert.deepEqual(all.map((fact) => fact.label).slice(12, 16), ["field.lyrics", "info.relativePath", "info.fileName", "info.format"]);
  });
});
