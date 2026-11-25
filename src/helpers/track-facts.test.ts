import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { track } from "./fixtures.test-support.ts";
import { allFacts, idFacts, trackFacts } from "./track-facts.ts";

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

describe("a track's ids", () => {
  it("shows the ones it has, each linked to its page, jackbird's own without a link", () => {
    const facts = idFacts({ mbAlbumId: "6a09041b", mbRecordingId: " 4a7fea2e ", discogsReleaseId: "1475007", jackbirdTrackId: "j-1", mbReleaseGroupId: "" }, t);
    assert.deepEqual(facts, [
      { label: "id.mbAlbumId", text: "6a09041b", mono: true, href: "https://musicbrainz.org/release/6a09041b" },
      { label: "id.mbRecordingId", text: "4a7fea2e", mono: true, href: "https://musicbrainz.org/recording/4a7fea2e" },
      { label: "id.discogsReleaseId", text: "1475007", mono: true, href: "https://www.discogs.com/release/1475007" },
      { label: "id.jackbirdTrackId", text: "j-1", mono: true }
    ]);
    assert.deepEqual(idFacts({}, t), []);
    assert.deepEqual(idFacts({ mbReleaseGroupId: "g", mbAlbumArtistId: "a", mbReleaseTrackId: "t" }, t).map((fact) => fact.href), [
      "https://musicbrainz.org/release-group/g",
      "https://musicbrainz.org/artist/a",
      "https://musicbrainz.org/track/t"
    ]);
  });

  it("follows the other facts in the selection's list", () => {
    const facts = trackFacts(track("a.mp3", { mbAlbumId: "x" }), t, "en");
    assert.equal(allFacts(facts).at(-1)?.label, "id.mbAlbumId");
  });
});
