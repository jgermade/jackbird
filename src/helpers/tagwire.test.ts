import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { WIRE_FIELDS, decodeError, decodeLayout, decodeSplice, decodeTags, encodeLayout, encodeRead, encodeWrite } from "./tagwire.ts";

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

describe("decodeError", () => {
  it("reads an error's code and message", () => {
    assert.deepEqual(decodeError(Uint8Array.from([...text("id3v22"), ...text("ID3v2.2 tags are read but not written")])), {
      code: "id3v22",
      message: "ID3v2.2 tags are read but not written"
    });
  });
});

// The layout of wire.rs' tests: FLAC, tags_end 10, audio 10..256.
const LAYOUT = [1, 10, 0, 0, 0, 10, 0, 0, 0, 0, 1, 0, 0];
const flac = { format: "flac", tagsEnd: 10, audio: { start: 10, end: 256 } } as const;

describe("decodeLayout and decodeSplice", () => {
  it("read a layout, or how many first bytes the engine needs", () => {
    assert.deepEqual(decodeLayout(Uint8Array.from([0, ...LAYOUT])), { known: flac });
    assert.deepEqual(decodeLayout(Uint8Array.of(0, 0, ...LAYOUT.slice(1))), { known: { ...flac, format: "mp3" } });
    assert.deepEqual(decodeLayout(Uint8Array.of(0, 255, ...LAYOUT.slice(1))), { known: { ...flac, format: null } });
    assert.deepEqual(decodeLayout(Uint8Array.of(1, 4, 3, 2, 1)), { needHead: 0x01020304 });
    assert.throws(() => decodeLayout(Uint8Array.of(0, 7, ...LAYOUT.slice(1))), /format 7/);
  });

  it("read a splice: where the replaced bytes end, and a copy of what replaces them", () => {
    const bytes = Uint8Array.of(7, 0, 0, 0, 110, 101, 119);
    const splice = decodeSplice(bytes);
    assert.deepEqual(splice, { replaceEnd: 7, with: Uint8Array.of(110, 101, 119) });
    bytes[4] = 0;
    assert.equal(splice.with[0], 110);
  });
});

describe("encodeLayout and encodeRead", () => {
  it("write the length, the tail and the head; or the layout and the head", () => {
    assert.deepEqual(encodeLayout(300, Uint8Array.of(1, 2), Uint8Array.of(9)), Uint8Array.of(44, 1, 0, 0, 2, 0, 0, 0, 1, 2, 9));
    assert.deepEqual(encodeRead(flac, Uint8Array.of(9, 9)), Uint8Array.from([...LAYOUT, 9, 9]));
    assert.deepEqual(encodeRead({ ...flac, format: null }, Uint8Array.of())[0], 255);
    assert.deepEqual(encodeRead({ ...flac, format: "mp3" }, Uint8Array.of())[0], 0);
  });
});

describe("encodeWrite", () => {
  it("writes the fields given, in order, then the cover, the layout and the head", () => {
    const head = Uint8Array.of(0x66, 0x4c, 0x61, 0x43);
    const bytes = encodeWrite({ fields: { title: "Título", album: "", year: "1959", track: "3/12" }, cover: { set: { mime: "image/png", data: Uint8Array.of(9, 8, 7) } } }, flac, head);
    // The request of wire.rs' test `reads_a_write_request`.
    assert.deepEqual(
      bytes,
      Uint8Array.from([1, ...text("Título"), 0, 1, ...text(""), 1, ...text("1959"), 0, 1, ...text("3/12"), 1, ...text("image/png"), ...run([9, 8, 7]), ...LAYOUT, 0x66, 0x4c, 0x61, 0x43])
    );
  });

  it("marks a cover kept with 0 and removed with 2", () => {
    const none = [0, 0, 0, 0, 0, 0];
    assert.deepEqual(encodeWrite({ fields: {}, cover: { keep: true } }, flac, Uint8Array.of(5)), Uint8Array.from([...none, 0, ...LAYOUT, 5]));
    assert.deepEqual(encodeWrite({ fields: {}, cover: { remove: true } }, flac, Uint8Array.of()), Uint8Array.from([...none, 2, ...LAYOUT]));
  });
});
