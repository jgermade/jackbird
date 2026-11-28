#!/usr/bin/env node
// Makes the `.m4a` tag fixtures (RECORD/2026-11-28.aac-m4a.WIP.md, A0): small MPEG-4 audio files
// whose boxes are built byte by byte around a little `ffmpeg` audio (AAC, and Apple Lossless),
// one made by macOS's `afconvert` and kept as it was made, and `cases-m4a.json`, which says what
// each must give. The expectations come from how each file is built, never from the code under
// test.
//
//   node fixtures/tags/make-m4a.mjs
//
// Needs `ffmpeg` (and `afconvert`, on macOS, only to make the Apple file the first time). Apart
// from `make.mjs` so that making these again leaves the MP3 and FLAC fixtures as they are (another
// `ffmpeg` encodes other bytes); it reuses their covers (`covers/`). The files are committed, so
// the tests need neither tool.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "jackbird-m4a-"));
const ffmpeg = (...args) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args]);

// ---------------------------------------------------------------- sources

const bitexact = ["-fflags", "+bitexact", "-flags:a", "+bitexact", "-map_metadata", "-1"];
const tone = ["-f", "lavfi", "-i", "sine=frequency=440:duration=0.5", "-ac", "1", "-ar", "22050"];
ffmpeg(...tone, "-c:a", "aac", "-b:a", "32k", ...bitexact, join(scratch, "aac.m4a"));
ffmpeg(...tone, "-c:a", "alac", ...bitexact, join(scratch, "alac.m4a"));
const cover = (name) => readFileSync(join(here, "covers", name));

// ---------------------------------------------------------------- bytes

const bytes = (...parts) => Buffer.concat(parts.map((part) => (typeof part === "string" ? Buffer.from(part, "latin1") : Buffer.from(part))));
const u16 = (n) => [(n >>> 8) & 0xff, n & 0xff];
const u32 = (n) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const u64 = (n) => {
  const out = Buffer.alloc(8);
  out.writeBigUInt64BE(BigInt(n));
  return out;
};
const sha1 = (data) => createHash("sha1").update(data).digest("hex");

/** A box: its 32-bit size, its four-letter type (latin1: `©` is 0xA9), its content. */
const box = (type, ...content) => {
  const body = bytes(...content);
  return bytes(u32(8 + body.length), type, body);
};
/** A full box: a box whose content starts with a version and 24 bits of flags. */
const fullBox = (type, version, flags, ...content) => box(type, [version, (flags >>> 16) & 0xff, (flags >>> 8) & 0xff, flags & 0xff], ...content);

/** The boxes of `data` between `start` and `end`, each with its type, where it is and its content. */
function boxes(data, start = 0, end = data.length) {
  const out = [];
  for (let at = start; at < end; ) {
    let size = data.readUInt32BE(at);
    let header = 8;
    if (size === 1) {
      size = Number(data.readBigUInt64BE(at + 8));
      header = 16;
    } else if (size === 0) size = end - at;
    out.push({ type: data.toString("latin1", at + 4, at + 8), at, size, body: data.subarray(at + header, at + size), raw: data.subarray(at, at + size) });
    at += size;
  }
  return out;
}
const child = (parent, type) => {
  const found = boxes(parent.body).find((one) => one.type === type);
  if (!found) throw new Error(`no ${type} in ${parent.type}`);
  return found;
};
const path = (parent, ...types) => types.reduce(child, parent);

/**
 * What `ffmpeg` encoded: the boxes kept as they are (the movie's and track's headers, the sample
 * description, the times and sizes) and every sample's bytes, found through the sample tables.
 */
function source(file) {
  const data = readFileSync(file);
  const top = boxes(data);
  const moov = top.find((one) => one.type === "moov");
  const trak = child(moov, "trak");
  const mdia = child(trak, "mdia");
  const minf = child(mdia, "minf");
  const stbl = child(minf, "stbl");
  const stsz = child(stbl, "stsz").body;
  const fixed = stsz.readUInt32BE(4);
  const count = stsz.readUInt32BE(8);
  const sizes = Array.from({ length: count }, (_, index) => (fixed !== 0 ? fixed : stsz.readUInt32BE(12 + 4 * index)));
  const stco = child(stbl, "stco").body;
  const offsets = Array.from({ length: stco.readUInt32BE(4) }, (_, index) => stco.readUInt32BE(8 + 4 * index));
  const stsc = child(stbl, "stsc").body;
  const runs = Array.from({ length: stsc.readUInt32BE(4) }, (_, index) => ({ first: stsc.readUInt32BE(8 + 12 * index), perChunk: stsc.readUInt32BE(12 + 12 * index) }));
  const samples = [];
  offsets.forEach((offset, index) => {
    const run = runs.filter((one) => one.first <= index + 1).at(-1);
    for (let n = 0, at = offset; n < run.perChunk && samples.length < count; n += 1) {
      const size = sizes[samples.length];
      samples.push(data.subarray(at, at + size));
      at += size;
    }
  });
  const kept = (parent, type) => boxes(parent.body).find((one) => one.type === type)?.raw ?? bytes();
  return {
    mvhd: child(moov, "mvhd").raw,
    tkhd: child(trak, "tkhd").raw,
    edts: kept(trak, "edts"),
    mdhd: child(mdia, "mdhd").raw,
    hdlr: child(mdia, "hdlr").raw,
    smhd: child(minf, "smhd").raw,
    dinf: child(minf, "dinf").raw,
    stsd: child(stbl, "stsd").raw,
    stts: child(stbl, "stts").raw,
    stsz: child(stbl, "stsz").raw,
    groups: bytes(kept(stbl, "sgpd"), kept(stbl, "sbgp")),
    samples
  };
}

const aac = source(join(scratch, "aac.m4a"));
const alac = source(join(scratch, "alac.m4a"));

// ---------------------------------------------------------------- tags (`ilst`)

const TYPE = { implicit: 0, utf8: 1, jpeg: 13, png: 14, integer: 21 };
const data = (type, ...value) => box("data", u32(type), u32(0), ...value);
const textAtom = (type, value) => box(type, data(TYPE.utf8, Buffer.from(value, "utf8")));
const freeform = (name, value, mean = "com.apple.iTunes") =>
  box("----", fullBox("mean", 0, 0, mean), fullBox("name", 0, 0, Buffer.from(name, "utf8")), data(TYPE.utf8, Buffer.from(value, "utf8")));
/** `trkn`: two bytes of nothing, the number, the total, two bytes of nothing. `disk`: without the last two. */
const trkn = (number, total) => box("trkn", data(TYPE.implicit, u16(0), u16(number), u16(total), u16(0)));
const disk = (number, total) => box("disk", data(TYPE.implicit, u16(0), u16(number), u16(total)));
const ilst = (...atoms) => box("ilst", ...atoms);
/** `meta` as iTunes writes it: a full box, its handler (`mdir`, `appl`), the list, and what follows. */
const meta = (list, ...after) => fullBox("meta", 0, 0, fullBox("hdlr", 0, 0, u32(0), "mdir", "appl", u32(0), u32(0), [0]), list, ...after);
const free = (length) => box("free", new Uint8Array(length - 8));

const UUID = "0b6c2b4e-1a2b-4c3d-9e8f-001122334455";
/** Every field jackbird has a place for, two covers, and atoms it does not know, which a save keeps. */
const fullList = () =>
  ilst(
    textAtom("\xa9nam", "Before"),
    textAtom("\xa9ART", "Artist"),
    textAtom("\xa9alb", "Album"),
    textAtom("\xa9day", "1959"),
    textAtom("\xa9gen", "Jazz"),
    trkn(3, 12),
    disk(1, 2),
    textAtom("aART", "Album Artist"),
    box("cpil", data(TYPE.integer, [1])),
    textAtom("\xa9wrt", "Composer"),
    textAtom("\xa9cmt", "A comment"),
    textAtom("\xa9lyr", "La la la"),
    box("tmpo", data(TYPE.integer, u16(120))),
    box("covr", data(TYPE.jpeg, cover("cover1.jpg")), data(TYPE.jpeg, cover("cover2.jpg"))),
    freeform("MusicBrainz Track Id", UUID),
    freeform("iTunSMPB", " 00000000 00000840 000001C0 0000000000002C40 00000000 00000000"),
    freeform("REPLAYGAIN_TRACK_GAIN", "-6.50 dB"),
    textAtom("\xa9too", "Lavf"),
    textAtom("soar", "Artist, The"),
    box("apID", data(TYPE.utf8, "someone@example.com")),
    box("xqzw", data(TYPE.implicit, [1, 2, 3, 0xff]))
  );
const EMPTY = { title: "", artist: "", album: "", year: "", genre: "", track: "", disc: "", albumArtist: "", compilation: "", composer: "", comment: "", lyrics: "", bpm: "" };
const FULL = { ...EMPTY, title: "Before", artist: "Artist", album: "Album", year: "1959", genre: "Jazz", track: "3/12", disc: "1/2", albumArtist: "Album Artist", compilation: "1", composer: "Composer", comment: "A comment", lyrics: "La la la", bpm: "120", mbRecordingId: UUID };
const COVER1 = { file: "covers/cover1.jpg", mime: "image/jpeg" };

// ---------------------------------------------------------------- files

const ftyp = box("ftyp", "M4A ", u32(0x200), "M4A ", "mp42", "isom", u32(0));

/**
 * A file: `ftyp`, then `moov` and `mdat` in the order asked, the samples in chunks of `perChunk`
 * one after another in `mdat`, the chunks' offsets in `stco` (or `co64`), worked out once `moov`'s
 * size is known. `udta` holds the tags; `between` goes between `moov` and `mdat`.
 */
function m4a(audio, { udta = null, moovLast = false, co64 = false, perChunk = 4, between = bytes(), largeMdat = false, qtMeta = false } = {}) {
  const payload = bytes(...audio.samples);
  const chunks = [];
  for (let at = 0, start = 0; at < audio.samples.length; at += perChunk) {
    chunks.push(start);
    start += audio.samples.slice(at, at + perChunk).reduce((sum, sample) => sum + sample.length, 0);
  }
  const lastRun = audio.samples.length % perChunk;
  const stsc = fullBox("stsc", 0, 0, u32(lastRun ? 2 : 1), u32(1), u32(perChunk), u32(1), ...(lastRun ? [u32(chunks.length), u32(lastRun), u32(1)] : []));
  const moovOf = (payloadStart) => {
    const offsets = chunks.map((start) => payloadStart + start);
    const table = co64 ? fullBox("co64", 0, 0, u32(offsets.length), ...offsets.map(u64)) : fullBox("stco", 0, 0, u32(offsets.length), ...offsets.map(u32));
    const stbl = box("stbl", audio.stsd, audio.stts, stsc, audio.stsz, table, audio.groups);
    const trak = box("trak", audio.tkhd, audio.edts, box("mdia", audio.mdhd, audio.hdlr, box("minf", audio.smhd, audio.dinf, stbl)));
    return box("moov", audio.mvhd, trak, udta ? box("udta", qtMeta ? udta.qt : udta.iso) : bytes());
  };
  const mdatHeader = largeMdat ? bytes(u32(1), "mdat", u64(16 + payload.length)) : bytes(u32(8 + payload.length), "mdat");
  if (moovLast) {
    const payloadStart = ftyp.length + mdatHeader.length;
    const file = bytes(ftyp, mdatHeader, payload, moovOf(payloadStart));
    return { file, region: { start: payloadStart, end: payloadStart + payload.length } };
  }
  // `moov`'s size does not depend on the offsets' values, so a first pass with 0 gives it.
  const payloadStart = ftyp.length + moovOf(0).length + between.length + mdatHeader.length;
  const file = bytes(ftyp, moovOf(payloadStart), between, mdatHeader, payload);
  return { file, region: { start: payloadStart, end: file.length } };
}

/** `udta`'s content: iTunes' `meta` (a full box), or QuickTime's (a plain box, no version or flags). */
const tags = (list, ...after) => ({ iso: meta(list, ...after), qt: box("meta", fullBox("hdlr", 0, 0, u32(0), "mdir", "appl", u32(0), u32(0), [0]), list, ...after) });

// ---------------------------------------------------------------- cases

const cases = [];
const expect = (fields, coverFile = null, write = "ok") => ({ fields, cover: coverFile, write });
const add = (name, audio, options, expected, about) => {
  const { file, region } = m4a(audio, options);
  cases.push({ name, file: `${name}.m4a`, format: "mp4", codec: audio === alac ? "alac" : "aac", about, ...expected, region, bytes: file });
};

add("m4a-faststart-padded", aac, { udta: tags(fullList(), free(1024)) }, expect(FULL, COVER1),
  "iTunes' layout: moov before mdat, every field, two covers, freeform and unknown atoms, 1 KiB of free after ilst in meta");
add("m4a-faststart-tight", aac, { udta: tags(fullList()) }, expect(FULL, COVER1),
  "moov before mdat and no free anywhere: a save that grows the tags shifts every chunk offset");
add("m4a-free-after-moov", aac, { udta: tags(fullList()), between: free(2048) }, expect(FULL, COVER1),
  "moov before mdat with 2 KiB of free between them, at the top level");
add("m4a-moov-last", aac, { udta: tags(fullList()), moovLast: true }, expect(FULL, COVER1),
  "mdat first, moov at the end (ffmpeg's own layout): no offset moves when the tags change");
add("m4a-co64", aac, { udta: tags(fullList()), co64: true, perChunk: 3 }, expect(FULL, COVER1),
  "64-bit chunk offsets (co64), chunks of three samples, no free");
add("m4a-large-mdat", aac, { udta: tags(fullList(), free(256)), largeMdat: true }, expect(FULL, COVER1),
  "mdat with a 64-bit size (a 16-byte header), the audio starting after it");
add("m4a-no-udta", aac, {}, expect(EMPTY),
  "no udta at all: a save adds one");
add("m4a-empty-ilst", aac, { udta: tags(ilst()) }, expect(EMPTY),
  "udta, meta and an empty ilst, as ffmpeg writes a file without metadata");
add("m4a-quicktime-meta", aac, { udta: tags(ilst(textAtom("\xa9nam", "QuickTime"), textAtom("\xa9ART", "Artist"))), qtMeta: true },
  expect({ ...EMPTY, title: "QuickTime", artist: "Artist" }),
  "meta as a plain box, without a version and flags (QuickTime's form, which some writers use)");
add("m4a-alac-png", alac, { udta: tags(ilst(textAtom("\xa9nam", "Lossless"), textAtom("\xa9ART", "Artist"), trkn(5, 0), disk(2, 0), box("covr", data(TYPE.png, cover("cover3.png")))), free(128)), perChunk: 2 },
  expect({ ...EMPTY, title: "Lossless", artist: "Artist", track: "5", disc: "2" }, { file: "covers/cover3.png", mime: "image/png" }),
  "Apple Lossless; a track and a disc without totals; a PNG cover");
add("m4a-gnre", aac, { udta: tags(ilst(textAtom("\xa9nam", "Numbered"), box("gnre", data(TYPE.implicit, u16(18))), box("cpil", data(TYPE.integer, [0]))), free(64)) },
  expect({ ...EMPTY, title: "Numbered", genre: "Rock" }),
  "the genre as gnre, ID3v1's number plus one (18: Rock), and cpil 0 (not a compilation)");
add("m4a-unicode", aac, { udta: tags(ilst(textAtom("\xa9nam", "Ñandú — 東京"), textAtom("\xa9ART", "Ölgaard"), textAtom("\xa9alb", "Ålbum")), free(64)) },
  expect({ ...EMPTY, title: "Ñandú — 東京", artist: "Ölgaard", album: "Ålbum" }),
  "UTF-8 beyond Latin-1");

{
  // Made once by macOS's `afconvert` from the same tone, and kept as it was made: a layout as
  // Apple's own tools write it, which no case above was built to have.
  const name = "m4a-made-by-afconvert";
  const file = join(here, `${name}.m4a`);
  if (!existsSync(file)) {
    ffmpeg(...tone, "-c:a", "pcm_s16le", ...bitexact, join(scratch, "tone.wav"));
    execFileSync("afconvert", ["-f", "m4af", "-d", "aac", "-b", "32000", join(scratch, "tone.wav"), file]);
  }
  const made = readFileSync(file);
  const top = boxes(made);
  const mdat = top.find((one) => one.type === "mdat");
  const moov = top.find((one) => one.type === "moov");
  const udta = boxes(moov.body).find((one) => one.type === "udta");
  // What the expectations rest on: afconvert writes no field jackbird has, only freeform atoms (its
  // `iTunSMPB`, the gapless information; and 3 KiB of free before mdat). If it ever writes another
  // atom, this case must say what it gives.
  const metaBox = udta && boxes(udta.body).find((one) => one.type === "meta");
  const list = metaBox && boxes(metaBox.body, 4).find((one) => one.type === "ilst");
  const atoms = list ? boxes(list.body).map((one) => one.type) : [];
  if (atoms.some((type) => type !== "----")) throw new Error(`${name} has ${atoms.join(", ")}: say what they give in its case`);
  cases.push({ name, file: `${name}.m4a`, format: "mp4", codec: "aac", about: "the same tone through macOS's afconvert (m4af, AAC), kept as it was made",
    ...expect(EMPTY), region: { start: mdat.at + (mdat.raw.length - mdat.body.length), end: mdat.at + mdat.size }, bytes: made });
}

// ---------------------------------------------------------------- write

for (const c of cases) {
  writeFileSync(join(here, c.file), c.bytes);
  c.region.sha1 = sha1(c.bytes.subarray(c.region.start, c.region.end));
  if (c.cover) c.cover.sha1 = sha1(cover(c.cover.file.replace("covers/", "")));
  c.size = c.bytes.length;
  delete c.bytes;
}
writeFileSync(join(here, "cases-m4a.json"), `${JSON.stringify({ about: "Made by fixtures/tags/make-m4a.mjs. Each case: the file, its codec, what reading it gives, its audio region (mdat's content: start, end, SHA-1), and what a save of a new title gives: ok, or the error's code.", cases }, null, 2)}\n`);
rmSync(scratch, { recursive: true, force: true });
console.log(`${cases.length} cases written to ${here}`);
