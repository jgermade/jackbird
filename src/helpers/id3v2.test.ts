import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { keepUneditedFrames, readId3v2, resynchronise, writeId3v2, type Id3Frame } from "./id3v2.ts";

const latin1 = (text: string): number[] => [...text].map((char) => char.charCodeAt(0));
/** A text frame: encoding 0 (ISO-8859-1), then the text. */
const text = (id: string, value: string, flags: [number, number] = [0, 0]): Id3Frame => ({ id, flags, body: new Uint8Array([0, ...latin1(value)]) });
/** A picture frame: encoding, MIME type, picture type, empty description, then the "image". */
const picture = (kind: number, data: string): Id3Frame => ({
  id: "APIC",
  flags: [0, 0],
  body: new Uint8Array([0, ...latin1("image/jpeg"), 0, kind, 0, ...latin1(data)])
});
const AUDIO = new Uint8Array([0xff, 0xfb, 0x90, 0x64, 1, 2, 3, 4]);
const file = (tag: Uint8Array): Uint8Array => {
  const out = new Uint8Array(tag.length + AUDIO.length);
  out.set(tag);
  out.set(AUDIO, tag.length);
  return out;
};
const ids = (tag: ReturnType<typeof readId3v2>): string[] => tag?.frames.map((frame) => frame.id) ?? [];
const textOf = (frame: Id3Frame | undefined): string => (frame ? String.fromCharCode(...frame.body.subarray(1)) : "");

describe("writeId3v2 and readId3v2", () => {
  const frames = [text("TIT2", "So What"), text("TPOS", "1/2"), picture(3, "front")];

  it("round-trips a v2.3 and a v2.4 tag, frame for frame", () => {
    for (const version of [3, 4] as const) {
      const tag = writeId3v2(version, frames);
      const read = readId3v2(file(tag));
      assert.equal(read?.version, version);
      assert.equal(read?.end, tag.length);
      assert.deepEqual(read?.frames, frames);
    }
  });

  it("writes v2.3 frame sizes plain and v2.4 ones syncsafe", () => {
    const long = { id: "TXXX", flags: [0, 0] as const, body: new Uint8Array(200) };
    assert.deepEqual([...writeId3v2(3, [long]).subarray(14, 18)], [0, 0, 0, 200]);
    assert.deepEqual([...writeId3v2(4, [long]).subarray(14, 18)], [0, 0, 1, 72]);
  });

  it("stops at padding", () => {
    const tag = writeId3v2(3, frames);
    const padded = new Uint8Array(tag.length + 64);
    padded.set(tag);
    const size = tag.length - 10 + 64;
    padded.set([(size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f], 6);
    const read = readId3v2(file(padded));
    assert.deepEqual(ids(read), ["TIT2", "TPOS", "APIC"]);
    assert.equal(read?.end, padded.length);
  });

  it("is null without a tag, for v2.2, and for frames that do not end cleanly", () => {
    assert.equal(readId3v2(AUDIO), null);
    assert.equal(readId3v2(new Uint8Array([0x49, 0x44, 0x33])), null);
    const v22 = writeId3v2(3, frames);
    v22[3] = 2;
    assert.equal(readId3v2(v22), null);
    const overlong = writeId3v2(3, [text("TIT2", "x")]);
    overlong[17] = 99;
    assert.equal(readId3v2(overlong), null);
    const garbage = writeId3v2(3, [text("TIT2", "x"), text("TPOS", "1")]);
    garbage.set(latin1("tp0s"), 10 + 12);
    assert.equal(readId3v2(garbage), null);
  });

  it("skips an extended header, in v2.3 and in v2.4", () => {
    for (const version of [3, 4] as const) {
      const plainTag = writeId3v2(version, frames);
      const extended = version === 3 ? [0, 0, 0, 6, 0, 0, 0, 0, 0, 0] : [0, 0, 0, 6, 1, 0];
      const tag = new Uint8Array(plainTag.length + extended.length);
      tag.set(plainTag.subarray(0, 10));
      tag.set(extended, 10);
      tag.set(plainTag.subarray(10), 10 + extended.length);
      tag[5] = 0x40;
      const size = tag.length - 10;
      tag.set([(size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f], 6);
      assert.deepEqual(readId3v2(file(tag))?.frames, frames);
    }
  });

  it("counts a v2.4 footer in where the audio starts", () => {
    const tag = writeId3v2(4, frames);
    tag[5] = 0x10;
    assert.equal(readId3v2(file(tag))?.end, tag.length + 10);
  });

  it("undoes a v2.3 tag's unsynchronisation", () => {
    const body = { id: "PRIV", flags: [0, 0] as const, body: new Uint8Array([0xff, 0xe0, 7]) };
    const tag = writeId3v2(3, [body]);
    // Unsynchronised: a 0x00 after the 0xFF, and the sizes grown by one.
    const unsynced = new Uint8Array([...tag.subarray(0, 20), 0xff, 0x00, 0xe0, 7]);
    unsynced[5] = 0x80;
    unsynced[9] = tag[9] + 1;
    assert.deepEqual(readId3v2(unsynced)?.frames, [body]);
  });

  it("reads a v2.4 tag written with plain frame sizes", () => {
    const long = { id: "TXXX", flags: [0, 0] as const, body: new Uint8Array(200).fill(7) };
    const tag = writeId3v2(4, [long]);
    tag.set([0, 0, 0, 200], 14);
    assert.deepEqual(readId3v2(tag)?.frames, [long]);
  });
});

describe("resynchronise", () => {
  it("drops each 0x00 that follows 0xFF, and only those", () => {
    assert.deepEqual([...resynchronise(new Uint8Array([0x00, 0xff, 0x00, 0xe0, 0xff, 0x00, 0x00, 1]))], [0x00, 0xff, 0xe0, 0xff, 0x00, 1]);
  });
});

describe("keepUneditedFrames", () => {
  // What browser-id3-writer leaves: a v2.3 tag with only the editor's frames, then the audio.
  const written = file(writeId3v2(3, [text("TIT2", "After"), text("TPE1", "Artist"), text("TALB", "Album"), text("TYER", "2020"), picture(3, "new")]));

  it("keeps every frame the editor does not manage, untouched and in order, after the written ones", () => {
    const kept = [text("TPOS", "2/2"), text("TPE2", "Album Artist"), { id: "COMM", flags: [0, 0] as const, body: new Uint8Array([0, 0x65, 0x6e, 0x67, 0, 1, 2]) }];
    const source = file(writeId3v2(3, [text("TIT2", "Before"), kept[0], text("TCON", "Jazz"), kept[1], kept[2]]));
    const result = readId3v2(keepUneditedFrames(source, written));
    assert.deepEqual(ids(result), ["TIT2", "TPE1", "TALB", "TYER", "APIC", "TPOS", "TPE2", "COMM"]);
    assert.deepEqual(result?.frames.slice(5), kept);
    assert.equal(textOf(result?.frames[0]), "After");
  });

  it("keeps the audio after the tag as the writer left it", () => {
    const source = file(writeId3v2(3, [text("TPOS", "1/1")]));
    const out = keepUneditedFrames(source, written);
    assert.deepEqual([...out.subarray(readId3v2(out)?.end)], [...AUDIO]);
  });

  it("replaces the first picture, the one the editor shows, and keeps the others", () => {
    const source = file(writeId3v2(3, [picture(0, "other"), picture(4, "back")]));
    const pictures = readId3v2(keepUneditedFrames(source, written))?.frames.filter((frame) => frame.id === "APIC") ?? [];
    assert.deepEqual(pictures, [picture(3, "new"), picture(4, "back")]);
  });

  it("writes in a v2.4 original's version, the year as TDRC, replacing its TDRC", () => {
    const source = file(writeId3v2(4, [text("TDRC", "1959"), text("TSOP", "Davis, Miles")]));
    const result = readId3v2(keepUneditedFrames(source, written));
    assert.equal(result?.version, 4);
    assert.deepEqual(ids(result), ["TIT2", "TPE1", "TALB", "TDRC", "APIC", "TSOP"]);
    assert.equal(textOf(result?.frames.find((frame) => frame.id === "TDRC")), "2020");
  });

  it("drops a frame flagged to be discarded when the tag is altered", () => {
    const v3 = file(writeId3v2(3, [text("TPOS", "1/2", [0x80, 0]), text("TPE2", "Kept")]));
    assert.deepEqual(ids(readId3v2(keepUneditedFrames(v3, written))).slice(5), ["TPE2"]);
    const v4 = file(writeId3v2(4, [text("TPOS", "1/2", [0x40, 0]), text("TPE2", "Kept")]));
    assert.deepEqual(ids(readId3v2(keepUneditedFrames(v4, written))).slice(5), ["TPE2"]);
  });

  it("returns what was written when there was no tag, or one it cannot read", () => {
    assert.equal(keepUneditedFrames(AUDIO, written), written);
    const v22 = file(writeId3v2(3, [text("TPOS", "1/2")]));
    v22[3] = 2;
    assert.equal(keepUneditedFrames(v22, written), written);
    assert.equal(keepUneditedFrames(file(writeId3v2(3, [text("TPOS", "1")])), AUDIO), AUDIO);
  });
});
