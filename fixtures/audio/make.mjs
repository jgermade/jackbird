#!/usr/bin/env node
// Makes the audio fixtures of crates/audio (E5): short FLAC and MP3 files at the rates and depths
// the native output must carry untouched, and `cases.json`, which says what each must give. The
// format and the length come from how each file is built; the PCM's MD5 from `ffmpeg`'s own
// decoder, never from the code under test. FLAC files also carry the MD5 of their PCM in
// STREAMINFO, which the tests check as well.
//
//   node fixtures/audio/make.mjs
//
// Needs `ffmpeg`. The files are committed, so the tests need neither. See
// RECORD/2026-08-11.musikmatch-rust-migration.WIP.md (2026-11-09, E5).

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const run = (...args) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { maxBuffer: 1 << 28 });
const bitexact = ["-fflags", "+bitexact", "-flags:a", "+bitexact", "-map_metadata", "-1"];

// A tone per channel, so a swapped or dropped channel shows: `left` and `right` in Hz.
const tone = (left, right, rate, seconds) => [
  "-f", "lavfi", "-i",
  `aevalsrc=0.5*sin(${left}*2*PI*t)|0.5*sin(${right}*2*PI*t):s=${rate}:d=${seconds}`
];

const files = [
  { name: "flac-24-96.flac", rate: 96000, bits: 24, seconds: 0.25, left: 1000, right: 3000, codec: ["-c:a", "flac", "-sample_fmt", "s32", "-bits_per_raw_sample", "24"], raw: "s24le" },
  { name: "flac-24-96-b.flac", rate: 96000, bits: 24, seconds: 0.2, left: 500, right: 1500, codec: ["-c:a", "flac", "-sample_fmt", "s32", "-bits_per_raw_sample", "24"], raw: "s24le" },
  { name: "flac-16-44.flac", rate: 44100, bits: 16, seconds: 0.25, left: 440, right: 880, codec: ["-c:a", "flac", "-sample_fmt", "s16"], raw: "s16le" },
  { name: "mp3-44.mp3", rate: 44100, bits: null, seconds: 0.25, left: 440, right: 660, codec: ["-c:a", "libmp3lame", "-b:a", "128k"], raw: null }
];

const cases = {};
for (const file of files) {
  const path = join(here, file.name);
  run(...tone(file.left, file.right, file.rate, file.seconds), "-ac", "2", ...file.codec, ...bitexact, path);
  const frames = Math.round(file.rate * file.seconds);
  const entry = { rate: file.rate, channels: 2, bits: file.bits, frames };
  if (file.raw) {
    // The PCM as FLAC's MD5 is defined: signed, little-endian, as many bytes as the depth needs.
    const pcm = execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", path, "-f", file.raw, "-"], { maxBuffer: 1 << 28 });
    entry.md5 = createHash("md5").update(pcm).digest("hex");
  }
  cases[file.name] = entry;
}
writeFileSync(join(here, "cases.json"), `${JSON.stringify(cases, null, 2)}\n`);
console.log(cases);
