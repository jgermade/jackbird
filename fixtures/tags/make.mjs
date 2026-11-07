#!/usr/bin/env node
// Makes the tag fixtures shared by `cargo test` (crates/tags) and, from E2,
// `npm test`: small MP3 and FLAC files whose tags and metadata blocks are
// built byte by byte around a little `ffmpeg` audio, one saved as the app saved
// before E2 (kept as it was made), and `cases.json`, which
// says what each must give. The expectations come from how each file is
// built, never from the code under test.
//
//   node --experimental-strip-types --disable-warning=ExperimentalWarning fixtures/tags/make.mjs
//
// Needs `ffmpeg`. The files are committed, so the
// tests need neither. See RECORD/2026-08-11.musikmatch-rust-migration.WIP.md
// (21:45 to 22:20).

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "jackbird-fixtures-"));
const ffmpeg = (...args) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args]);

// ---------------------------------------------------------------- sources

const bitexact = ["-fflags", "+bitexact", "-flags:a", "+bitexact", "-map_metadata", "-1"];
ffmpeg("-f", "lavfi", "-i", "sine=frequency=440:duration=0.5", "-ac", "1", "-ar", "22050", "-c:a", "libmp3lame", "-b:a", "32k", "-id3v2_version", "0", "-write_xing", "0", ...bitexact, join(scratch, "audio.mp3"));
ffmpeg("-f", "lavfi", "-i", "sine=frequency=440:duration=0.5", "-ac", "1", "-ar", "8000", "-c:a", "flac", ...bitexact, join(scratch, "audio.flac"));
mkdirSync(join(here, "covers"), { recursive: true });
ffmpeg("-f", "lavfi", "-i", "testsrc=size=16x16", "-frames:v", "1", "-q:v", "8", ...bitexact, join(here, "covers/cover1.jpg"));
ffmpeg("-f", "lavfi", "-i", "testsrc2=size=24x24", "-frames:v", "1", "-q:v", "8", ...bitexact, join(here, "covers/cover2.jpg"));
ffmpeg("-f", "lavfi", "-i", "smptebars=size=16x16", "-frames:v", "1", ...bitexact, join(here, "covers/cover3.png"));
ffmpeg("-f", "lavfi", "-i", "testsrc=size=32x32:rate=1", "-frames:v", "1", "-q:v", "8", ...bitexact, join(here, "covers/cover9.jpg"));

const mp3Audio = readFileSync(join(scratch, "audio.mp3"));
const cover = (name) => readFileSync(join(here, "covers", name));

// ---------------------------------------------------------------- bytes

const bytes = (...parts) => Buffer.concat(parts.map((part) => (typeof part === "string" ? Buffer.from(part, "latin1") : Buffer.from(part))));
const syncsafe = (n) => [(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f];
const u32be = (n) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const u32le = (n) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
const sha1 = (data) => createHash("sha1").update(data).digest("hex");

function unsynchronise(data) {
  const out = [];
  data.forEach((byte, at) => {
    out.push(byte);
    if (byte === 0xff && (at + 1 === data.length || data[at + 1] >= 0xe0 || data[at + 1] === 0)) out.push(0);
  });
  return Buffer.from(out);
}

// Text in an encoding: 0 ISO-8859-1, 1 UTF-16 with a byte order mark (LE), 2 UTF-16BE, 3 UTF-8.
function encoded(encoding, value) {
  if (encoding === 0) return Buffer.from(value, "latin1");
  if (encoding === 3) return Buffer.from(value, "utf8");
  const le = Buffer.from(value, "utf16le");
  if (encoding === 1) return bytes([0xff, 0xfe], le);
  const be = Buffer.from(le);
  be.swap16();
  return be;
}

const frame = (id, body, flags = [0, 0]) => ({ id, body: Buffer.from(body), flags });
const text = (id, encoding, value) => frame(id, bytes([encoding], encoded(encoding, value)));
function apic(encoding, kind, mime, description, data) {
  const terminator = encoding === 1 || encoding === 2 ? [0, 0] : [0];
  return frame("APIC", bytes([encoding], mime, [0, kind], encoded(encoding, description), terminator, data));
}

/** An ID3v2 tag. `plainSizes`: v2.4 frame sizes as plain integers; `unsync`: v2.3 whole-tag unsynchronisation. */
function tag(version, frames, { padding = 0, unsync = false, plainSizes = false, extended = null, footer = false, junk = null } = {}) {
  let body = bytes(
    ...frames.map((f) => bytes(f.id, version === 4 && !plainSizes ? syncsafe(f.body.length) : u32be(f.body.length), f.flags, f.body))
  );
  if (unsync) body = unsynchronise(body);
  if (extended) body = bytes(extended, body);
  if (junk) body = bytes(body, junk);
  body = bytes(body, new Uint8Array(padding));
  let flags = 0;
  if (unsync) flags |= 0x80;
  if (extended) flags |= 0x40;
  if (footer) flags |= 0x10;
  const header = bytes("ID3", [version, 0, flags], syncsafe(body.length));
  return footer ? bytes(header, body, "3DI", [version, 0, flags], syncsafe(body.length)) : bytes(header, body);
}

/** A v2.2 tag: three-letter ids, three-byte sizes, no flags. */
function tag22(frames, padding) {
  const body = bytes(...frames.map((f) => bytes(f.id, [(f.body.length >> 16) & 0xff, (f.body.length >> 8) & 0xff, f.body.length & 0xff], f.body)), new Uint8Array(padding));
  return bytes("ID3", [2, 0, 0], syncsafe(body.length), body);
}

/** E0's eighteen frames, in a version's text encoding (ISO-8859-1 in v2.3, UTF-8 in v2.4). */
function e0Frames(version) {
  const enc = version === 4 ? 3 : 0;
  return [
    text("TIT2", enc, "Before"),
    text("TPE1", enc, "Artist"),
    text("TALB", enc, "Album"),
    text(version === 4 ? "TDRC" : "TYER", enc, "1959"),
    text("TCON", enc, "Jazz"),
    text("TRCK", enc, "3/12"),
    text("TPOS", enc, "1/2"),
    text("TPE2", enc, "Album Artist"),
    frame("COMM", bytes([enc], "eng", [0], "A comment")),
    frame("TXXX", bytes([enc], "REPLAYGAIN_TRACK_GAIN", [0], "-6.50 dB")),
    frame("USLT", bytes([enc], "eng", [0], "La la la")),
    frame("UFID", bytes("http://musicbrainz.org", [0], "0b6c2b4e-1a2b-4c3d-9e8f-001122334455")),
    frame("PRIV", bytes("WM/MediaClassPrimaryID", [0], [0xbc, 0x7d, 0x60, 0xd1, 0x23, 0xe3, 0xe2, 0x4b, 0x86, 0xa1, 0x48, 0xa4, 0x2a, 0x28, 0x44, 0x1e])),
    apic(0, 3, "image/jpeg", "", cover("cover1.jpg")),
    apic(0, 4, "image/jpeg", "back", cover("cover2.jpg")),
    frame("XQZW", [1, 2, 3, 0xff, 0xe0, 4]),
    text("TCMP", enc, "1"),
    text("TPE4", enc, "Remixer (to discard)", undefined),
  ].map((f) => (f.id === "TPE4" ? { ...f, flags: [version === 4 ? 0x40 : 0x80, 0] } : f));
}

const E0_FIELDS = { title: "Before", artist: "Artist", album: "Album", year: "1959", genre: "Jazz", track: "3/12" };
const EMPTY = { title: "", artist: "", album: "", year: "", genre: "", track: "" };
const COVER1 = { file: "covers/cover1.jpg", mime: "image/jpeg" };

const id3v1 = bytes("TAG", "Before".padEnd(30, " "), "Artist".padEnd(30, " "), "Album".padEnd(30, " "), "1959", "v1 comment".padEnd(28, " "), [0, 3, 8]);

function apeTag() {
  const item = bytes(u32le(4), u32le(0), "Title", [0], "Ape!");
  const size = item.length + 32;
  const header = (flags) => bytes("APETAGEX", u32le(2000), u32le(size), u32le(1), u32le(flags), new Uint8Array(8));
  return bytes(header(0xa0000000), item, header(0x80000000));
}

// ---------------------------------------------------------------- FLAC

function flacParts(file) {
  let at = 4;
  const blocks = [];
  for (;;) {
    const last = file[at] & 0x80;
    const length = (file[at + 1] << 16) | (file[at + 2] << 8) | file[at + 3];
    blocks.push({ kind: file[at] & 0x7f, body: file.subarray(at + 4, at + 4 + length) });
    at += 4 + length;
    if (last) return { blocks, audio: file.subarray(at) };
  }
}

const flacSource = flacParts(readFileSync(join(scratch, "audio.flac")));
const streaminfo = flacSource.blocks[0];
const flacAudio = flacSource.audio;
const block = (kind, body) => ({ kind, body: Buffer.from(body) });

function flac(prefix, blocks) {
  const metadata = blocks.map((b, index) => bytes([(index + 1 === blocks.length ? 0x80 : 0) | b.kind], [(b.body.length >> 16) & 0xff, (b.body.length >> 8) & 0xff, b.body.length & 0xff], b.body));
  return bytes(prefix, "fLaC", ...metadata, flacAudio);
}

function vorbis(vendor, entries) {
  return block(4, bytes(u32le(Buffer.byteLength(vendor)), Buffer.from(vendor, "utf8"), u32le(entries.length), ...entries.map((entry) => {
    const raw = typeof entry === "string" ? Buffer.from(entry, "utf8") : Buffer.from(entry);
    return bytes(u32le(raw.length), raw);
  })));
}

function picture(kind, mime, description, data, [width, height, depth]) {
  return block(6, bytes(u32be(kind), u32be(mime.length), mime, u32be(Buffer.byteLength(description)), Buffer.from(description, "utf8"), u32be(width), u32be(height), u32be(depth), u32be(0), u32be(data.length), data));
}

function cuesheet() {
  const b = streaminfo.body;
  const samples = (BigInt(b[13] & 0x0f) << 32n) | BigInt(b.readUInt32BE(14));
  const u64 = (n) => { const out = Buffer.alloc(8); out.writeBigUInt64BE(BigInt(n)); return out; };
  return block(5, bytes(new Uint8Array(128), u64(0), [0], new Uint8Array(258), [2],
    u64(0), [1], new Uint8Array(12), [0], new Uint8Array(13), [1], u64(0), [1], new Uint8Array(3),
    u64(samples), [255], new Uint8Array(12), [0], new Uint8Array(13), [0]));
}

const seektable = block(3, bytes(new Uint8Array(16), [0x10, 0x00]));
const application = block(2, "jkbdsome application data");
const fullComments = vorbis("reference libFLAC 1.4.3 20230623", [
  "TITLE=Before", "ARTIST=One", "ARTIST=Two", "ALBUM=Album", "DATE=1959", "GENRE=Jazz", "TRACKNUMBER=3",
  "ALBUMARTIST=Album Artist", "DISCNUMBER=1", "REPLAYGAIN_TRACK_GAIN=-6.50 dB", "replaygain_album_gain=-7.00 dB",
  "MUSICBRAINZ_TRACKID=0b6c2b4e-1a2b-4c3d-9e8f-001122334455", "LYRICS=La la la", "COMMENT=Hi",
]);
const fullBlocks = [
  streaminfo, seektable, application, fullComments, cuesheet(),
  picture(3, "image/jpeg", "", cover("cover1.jpg"), [16, 16, 24]),
  picture(4, "image/jpeg", "back", cover("cover2.jpg"), [24, 24, 24]),
  block(1, new Uint8Array(512)),
];
const FLAC_FIELDS = { title: "Before", artist: "One", album: "Album", year: "1959", genre: "Jazz", track: "3" };

// ---------------------------------------------------------------- cases

const cases = [];
const mp3 = (name, tagBytes, expected, { tail = null, about }) => {
  const file = bytes(tagBytes, mp3Audio, tail ?? []);
  const start = tagBytes.length;
  let end = file.length;
  if (tail === id3v1) end -= 128;
  if (tail && tail !== id3v1) end -= 32; // an APEv2 tag: only its footer is outside the region, as the audio region has it
  cases.push({ name, file: `${name}.mp3`, format: "mp3", about, ...expected, region: { start, end } , bytes: file });
};
const flacCase = (name, prefix, blocks, expected, about) => {
  const file = flac(prefix, blocks);
  cases.push({ name, file: `${name}.flac`, format: "flac", about, ...expected, region: { start: file.length - flacAudio.length, end: file.length }, bytes: file });
};
const expect = (fields, coverFile = null, write = "ok") => ({ fields, cover: coverFile, write });

mp3("mp3-v23-padded", tag(3, e0Frames(3), { padding: 256 }), expect(E0_FIELDS, COVER1), { about: "E0's eighteen frames in v2.3, with padding" });
mp3("mp3-v24-padded", tag(4, e0Frames(4), { padding: 256 }), expect(E0_FIELDS, COVER1), { about: "E0's eighteen frames in v2.4 (UTF-8, TDRC), with padding" });
mp3("mp3-v23-unsync", tag(3, e0Frames(3), { unsync: true }), expect(E0_FIELDS, COVER1), { about: "v2.3 with the whole tag unsynchronised, no padding" });
mp3("mp3-v24-plain-sizes", tag(4, e0Frames(4), { plainSizes: true }), expect(E0_FIELDS, COVER1), { about: "v2.4 with plain frame sizes, as old iTunes wrote them" });
mp3("mp3-v23-ext-header", tag(3, e0Frames(3).slice(0, 6), { padding: 64, extended: [0, 0, 0, 6, 0, 0, 0, 0, 0, 64] }), expect(E0_FIELDS), { about: "v2.3 with an extended header" });
mp3("mp3-v24-ext-header", tag(4, e0Frames(4).slice(0, 6), { padding: 64, extended: [0, 0, 0, 6, 1, 0] }), expect(E0_FIELDS), { about: "v2.4 with an extended header" });
mp3("mp3-v24-footer", tag(4, e0Frames(4).slice(0, 6), { footer: true }), expect(E0_FIELDS), { about: "v2.4 with a footer, which the audio region starts after" });
mp3("mp3-v23-id3v1", tag(3, e0Frames(3), { padding: 128 }), expect(E0_FIELDS, COVER1), { tail: id3v1, about: "v2.3 and an ID3v1 tag at the end" });
mp3("mp3-v24-ape", tag(4, e0Frames(4).slice(0, 6), { padding: 32 }), expect(E0_FIELDS), { tail: apeTag(), about: "v2.4 and an APEv2 tag at the end" });
mp3("mp3-no-tag", bytes(), expect(EMPTY), { about: "no tag at all" });

{
  const content = bytes([0], "Flagged\xff\xe0");
  const raw = bytes([9], syncsafe(content.length), content);
  const frames = [
    { id: "TIT2", flags: [0, 0x43], body: unsynchronise(raw) },
    text("TPE1", 3, "Artist"),
    { id: "TXXX", flags: [0, 0x40], body: bytes([7, 3], "KEY", [0], "value") },
  ];
  mp3("mp3-v24-frame-flags", tag(4, frames, { padding: 64 }), expect({ ...EMPTY, title: "Flaggedÿà", artist: "Artist" }), { about: "v2.4 frames with their own unsynchronisation, group and data length indicator" });
}
mp3("mp3-duplicates", tag(3, [text("TIT2", 0, "First"), text("TIT2", 0, "Second"), frame("TXXX", bytes([0], "a", [0], "one")), frame("TXXX", bytes([0], "a", [0], "two")), text("TPE1", 0, "Artist")], { padding: 64 }),
  expect({ ...EMPTY, title: "First", artist: "Artist" }), { about: "two TIT2 and two TXXX with one description (invalid, but found in files)" });
mp3("mp3-odd-years", tag(4, [text("TIT2", 3, "Odd"), text("TDRC", 3, "c. 1959"), text("TCON", 3, "(17)")], { padding: 64 }),
  expect({ ...EMPTY, title: "Odd", year: "c. 1959", genre: "(17)" }), { about: "a year that is not a date, and a genre by its ID3v1 number" });
mp3("mp3-empty-frames", tag(3, [frame("TIT2", [0]), frame("TPE1", []), text("TALB", 0, "x"), frame("TCON", [0, 0])], { padding: 64 }),
  expect({ ...EMPTY, album: "x" }), { about: "a text frame with only its encoding, one of size 0, one with only a terminator" });
mp3("mp3-v23-utf16", tag(3, [text("TIT2", 1, "Ñandú — 東京"), frame("TPE1", bytes([1, 0xfe, 0xff], encoded(2, "Ölgaard"))), text("TALB", 1, "Ålbum")], { padding: 64 }),
  expect({ ...EMPTY, title: "Ñandú — 東京", artist: "Ölgaard", album: "Ålbum" }), { about: "UTF-16 with little- and big-endian byte order marks" });
mp3("mp3-v24-unicode", tag(4, [text("TIT2", 2, "東京"), text("TPE1", 3, "One\0Two"), frame("TALB", bytes([1], encoded(1, "A"), [0, 0], encoded(1, "B")))], { padding: 64 }),
  expect({ ...EMPTY, title: "東京", artist: "One/Two", album: "A/B" }), { about: "UTF-16BE, and several values in UTF-8 and in UTF-16" });
mp3("mp3-v22", tag22([frame("TT2", bytes([0], "Old")), frame("TP1", bytes([0], "Artist")), frame("TAL", bytes([0], "Album")), frame("TYE", bytes([0], "1990")), frame("TCO", bytes([0], "Rock")), frame("TRK", bytes([0], "1/9")), frame("PIC", bytes([0], "JPG", [3, 0], cover("cover2.jpg"))), frame("COM", bytes([0], "eng", [0], "hi"))], 32),
  expect({ title: "Old", artist: "Artist", album: "Album", year: "1990", genre: "Rock", track: "1/9" }, { file: "covers/cover2.jpg", mime: "image/jpeg" }, "id3v22"), { about: "ID3v2.2 (read; a save is refused)" });
mp3("mp3-junk", tag(3, [text("TIT2", 0, "Junk"), text("TPE1", 0, "Artist")], { padding: 16, junk: [1, 2, 3, 4] }),
  expect({ ...EMPTY, title: "Junk", artist: "Artist" }, null, "unreadable"), { about: "bytes after the frames that are neither a frame nor padding (read; a save is refused)" });

{
  // What the app wrote before E2 when it retitled mp3-v23-padded (browser-id3-writer, then
  // keepUneditedFrames, both retired in E2): made by an earlier run of this script, and kept as
  // it is, since nothing writes it that way any more.
  const saved = readFileSync(join(here, "mp3-saved-by-jackbird.mp3"));
  const tagLength = 10 + ((saved[6] << 21) | (saved[7] << 14) | (saved[8] << 7) | saved[9]);
  cases.push({ name: "mp3-saved-by-jackbird", file: "mp3-saved-by-jackbird.mp3", format: "mp3", about: "mp3-v23-padded retitled by the app before E2 (browser-id3-writer, then keepUneditedFrames)",
    ...expect({ ...E0_FIELDS, title: "After" }, COVER1), region: { start: tagLength, end: saved.length }, bytes: saved });
}

flacCase("flac-full", [], fullBlocks, expect(FLAC_FIELDS, COVER1), "STREAMINFO, SEEKTABLE, APPLICATION, 14 comments (two ARTIST, a lower-case key), CUESHEET, two pictures, padding last");
flacCase("flac-padding-first", [], [fullBlocks[0], fullBlocks[7], ...fullBlocks.slice(1, 7)], expect(FLAC_FIELDS, COVER1), "flac-full with the padding second");
flacCase("flac-no-padding", [], fullBlocks.slice(0, 7), expect(FLAC_FIELDS, COVER1), "flac-full without padding");
flacCase("flac-id3-prefix", tag(3, [text("TIT2", 0, "id3 before fLaC")]), fullBlocks, expect(FLAC_FIELDS, COVER1), "flac-full after an ID3v2 tag, which FLAC readers skip");
flacCase("flac-no-comments", [], [streaminfo, block(1, new Uint8Array(64))], expect(EMPTY), "STREAMINFO and padding only");
flacCase("flac-odd-comments", [], [streaminfo, vorbis("odd", ["TITLE=Odd", "NOEQUALS", bytes("COMMENT=", [0xff, 0xfe]), "KéY=v", "title=lower"]), block(1, new Uint8Array(64))],
  expect({ ...EMPTY, title: "Odd" }), "an entry without =, one with invalid UTF-8, a key with a non-ASCII letter, a second title in lower case");
flacCase("flac-track-total", [], [streaminfo, vorbis("totals", ["TITLE=Totals", "TRACKNUMBER=3", "TOTALTRACKS=12", "YEAR=2001"]), picture(3, "image/png", "", cover("cover3.png"), [16, 16, 24]), block(1, new Uint8Array(64))],
  expect({ ...EMPTY, title: "Totals", year: "2001", track: "3/12" }, { file: "covers/cover3.png", mime: "image/png" }), "TRACKNUMBER with TOTALTRACKS, YEAR without DATE, a PNG cover");

// ---------------------------------------------------------------- write

for (const c of cases) {
  writeFileSync(join(here, c.file), c.bytes);
  c.region.sha1 = sha1(c.bytes.subarray(c.region.start, c.region.end));
  if (c.cover) c.cover.sha1 = sha1(cover(c.cover.file.replace("covers/", "")));
  c.size = c.bytes.length;
  delete c.bytes;
}
writeFileSync(join(here, "cases.json"), `${JSON.stringify({ about: "Made by fixtures/tags/make.mjs. Each case: the file, what reading it gives, its audio region (start, end, SHA-1), and what a save of a new title gives: ok, or the error's code.", cases }, null, 2)}\n`);
rmSync(scratch, { recursive: true, force: true });
console.log(`${cases.length} cases written to ${here}`);
