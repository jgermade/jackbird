import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { WIRE_FIELDS, decodeError, decodeRegion, decodeTags, encodeWrite } from "./tagwire.ts";

const u32 = (value: number) => [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, value >>> 24];
const run = (bytes: number[]) => [...u32(bytes.length), ...bytes];
const text = (value: string) => run([...new TextEncoder().encode(value)]);

describe("decodeTags", () => {
  it("reads the format, the six fields in order and the cover, as crates/tags-wasm writes them", () => {
    // The bytes of wire.rs' test `writes_tags_errors_and_regions`.
    const bytes = Uint8Array.from([1, ...text("T"), ...text(""), ...text(""), ...text("1959"), ...text(""), ...text(""), 1, ...text("image/jpeg"), ...run([1, 2])]);
    const tags = decodeTags(bytes);
    assert.deepEqual(tags, {
      format: "flac",
      fields: { title: "T", artist: "", album: "", year: "1959", genre: "", track: "" },
      cover: { mime: "image/jpeg", data: Uint8Array.of(1, 2) }
    });
    // The cover is a copy: changing the answer's buffer leaves it alone.
    bytes[bytes.length - 1] = 9;
    assert.deepEqual(tags.cover?.data, Uint8Array.of(1, 2));
  });

  it("reads an MP3 without a cover, and UTF-8", () => {
    const bytes = Uint8Array.from([0, ...text("Título"), ...text("Artist"), ...text(""), ...text(""), ...text("(17)"), ...text("3/12"), 0]);
    assert.deepEqual(decodeTags(bytes), {
      format: "mp3",
      fields: { title: "Título", artist: "Artist", album: "", year: "", genre: "(17)", track: "3/12" },
      cover: null
    });
  });

  it("reads from a view into a larger buffer", () => {
    const inner = [0, ...WIRE_FIELDS.flatMap(() => text("x")), 0];
    const outer = Uint8Array.from([7, 7, ...inner, 7]);
    assert.equal(decodeTags(outer.subarray(2, 2 + inner.length)).fields.track, "x");
  });

  it("throws on an answer that ends early, an unknown format or text that is not UTF-8", () => {
    assert.throws(() => decodeTags(Uint8Array.of()), /ends early, at byte 0/);
    assert.throws(() => decodeTags(Uint8Array.of(0, ...u32(5), 1)), /ends early/);
    assert.throws(() => decodeTags(Uint8Array.of(2)), /format 2/);
    assert.throws(() => decodeTags(Uint8Array.of(0, ...run([0xff]))), TypeError);
  });
});

describe("decodeError and decodeRegion", () => {
  it("read an error's code and message", () => {
    assert.deepEqual(decodeError(Uint8Array.from([...text("id3v22"), ...text("ID3v2.2 tags are read but not written")])), {
      code: "id3v22",
      message: "ID3v2.2 tags are read but not written"
    });
  });

  it("read a region's start and end", () => {
    assert.deepEqual(decodeRegion(Uint8Array.of(10, 0, 0, 0, 4, 3, 2, 1)), { start: 10, end: 0x01020304 });
    assert.throws(() => decodeRegion(Uint8Array.of(1, 2, 3)), /ends early/);
  });
});

describe("encodeWrite", () => {
  it("writes the fields given, in order, then the cover, then the file", () => {
    const file = Uint8Array.of(0x49, 0x44, 0x33);
    const bytes = encodeWrite({ fields: { title: "Título", album: "", year: "1959", track: "3/12" }, cover: { set: { mime: "image/png", data: Uint8Array.of(9, 8, 7) } } }, file);
    // The request of wire.rs' test `reads_an_edit_and_where_the_file_starts`.
    assert.deepEqual(
      bytes,
      Uint8Array.from([1, ...text("Título"), 0, 1, ...text(""), 1, ...text("1959"), 0, 1, ...text("3/12"), 1, ...text("image/png"), ...run([9, 8, 7]), 0x49, 0x44, 0x33])
    );
  });

  it("marks a cover kept with 0 and removed with 2", () => {
    const none = Uint8Array.of(0, 0, 0, 0, 0, 0);
    assert.deepEqual(encodeWrite({ fields: {}, cover: { keep: true } }, Uint8Array.of(5)), Uint8Array.of(...none, 0, 5));
    assert.deepEqual(encodeWrite({ fields: {}, cover: { remove: true } }, Uint8Array.of()), Uint8Array.of(...none, 2));
  });
});
