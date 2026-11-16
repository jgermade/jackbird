import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { track } from "./fixtures.test-support.ts";
import { bestOf, extraCopies, findDuplicates, keptOf, tagsFilled } from "./duplicates.ts";

const withAudio = (path: string, audio: string, metadata = {}, size = 1000) => ({ ...track(path, metadata), audioChecksum: audio, size });

describe("findDuplicates", () => {
  const smash = { title: "Self Esteem", artist: "The Offspring", album: "Smash" };
  const tracks = [
    withAudio("Smash/08 Self Esteem.mp3", "A", smash),
    withAudio("Smash/01 Time to Relax.mp3", "T", { title: "Time to Relax", artist: "The Offspring", album: "Smash" }),
    withAudio("Loose/self esteem.mp3", "A", { title: "Self Esteem", artist: "The Offspring" }),
    withAudio("Live/Self Esteem (Live).flac", "L", { title: "Self-Esteem", artist: "the offspring" }, 9000),
    withAudio("x/untitled.mp3", "U", {}),
    withAudio("y/untitled copy.mp3", "U2", {})
  ];

  it("groups the same audio as exact copies, and the same song with other audio as probable", () => {
    const found = findDuplicates(tracks);
    assert.deepEqual(found.exact.map((group) => group.trackIds), [["Loose/self esteem.mp3", "Smash/08 Self Esteem.mp3"]]);
    assert.deepEqual(found.probable.map((group) => group.trackIds), [["Live/Self Esteem (Live).flac", "Loose/self esteem.mp3", "Smash/08 Self Esteem.mp3"]]);
  });

  it("leaves out tracks with no audio checksum from exact copies, and untitled ones from probable", () => {
    const found = findDuplicates([track("a.mp3", { title: "Same" }), track("b.mp3", { title: "Same" }), track("c.mp3"), track("d.mp3")]);
    assert.equal(found.exact.length, 0);
    assert.deepEqual(found.probable.map((group) => group.trackIds), [["a.mp3", "b.mp3"]]);
  });

  it("keeps the copy in its album's folder, then the fullest tags, a cover, the shortest path", () => {
    const pair = tracks.filter((one) => one.audioChecksum === "A");
    assert.equal(keptOf(pair, tracks).relativePath, "Smash/08 Self Esteem.mp3");
    const tagged = [withAudio("b/x.mp3", "Z", { title: "X" }), withAudio("a/longer/x.mp3", "Z", { title: "X", artist: "Y", year: "2000" })];
    assert.equal(keptOf(tagged, tagged).relativePath, "a/longer/x.mp3");
    const covered = [withAudio("a/x.mp3", "Z", { title: "X" }), withAudio("b/longer/x.mp3", "Z", { title: "X", coverDataUrl: "jackbird-cover:c.jpg" })];
    assert.equal(keptOf(covered, covered).relativePath, "b/longer/x.mp3");
    const plain = [withAudio("long/path/x.mp3", "Z", { title: "X" }), withAudio("a/x.mp3", "Z", { title: "X" })];
    assert.equal(keptOf(plain, plain).relativePath, "a/x.mp3");
    assert.equal(tagsFilled(tracks[0]), 3);
  });

  it("marks every exact copy but the one kept", () => {
    const found = findDuplicates(tracks);
    assert.deepEqual(extraCopies(found.exact, tracks), ["Loose/self esteem.mp3"]);
  });

  it("points out the best in quality: lossless, then the largest", () => {
    const group = tracks.filter((one) => /self/i.test(one.relativePath));
    assert.equal(bestOf(group).relativePath, "Live/Self Esteem (Live).flac");
    assert.equal(bestOf([withAudio("a.mp3", "1", {}, 10), withAudio("b.mp3", "2", {}, 20)]).relativePath, "b.mp3");
    // The bit rate before the size: a 320 kbps file smaller than a 128 kbps one (shorter) is better.
    const rated = (path: string, bitrate: number, size: number) => ({ ...withAudio(path, path, {}, size), audio: { durationMs: 1, bitrate, sampleRate: 44_100, channels: 2, bits: 0, vbr: false } });
    assert.equal(bestOf([rated("big.mp3", 128, 9000), rated("good.mp3", 320, 5000)]).relativePath, "good.mp3");
  });
});
