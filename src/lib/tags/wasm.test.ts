// The shared fixtures (fixtures/tags/, made by make.mjs) against the built
// module (src/lib/tags/engine.wasm, scripts/build-wasm.mjs, which `npm test`
// runs first), as the app drives it (./engine.ts): what reading each gives,
// its layout and audio region, and what saving a new title gives. The same
// expectations `cargo test` checks natively.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { WireEdit } from "../../helpers/tagwire.ts";
import { layoutOf, readOf, writeOf } from "./engine.ts";
import { TagError } from "./error.ts";
import { instantiate, type Engine } from "./wasm.ts";

type Case = {
  name: string;
  file: string;
  format: "mp3" | "flac";
  fields: Record<string, string>;
  cover: { file: string; mime: string; sha1: string } | null;
  write: string;
  region: { start: number; end: number; sha1: string };
  size: number;
};

const fixtures = new URL("../../../fixtures/tags/", import.meta.url);
const cases: Case[] = JSON.parse(readFileSync(new URL("cases.json", fixtures), "utf8")).cases;
const bytesOf = (name: string) => new Uint8Array(readFileSync(new URL(name, fixtures)));
const sha1 = (bytes: Uint8Array) => createHash("sha1").update(bytes).digest("hex");
const engine: Engine = await instantiate(readFileSync(fileURLToPath(new URL("./engine.wasm", import.meta.url))));
const keep = { keep: true } as const;

// The engine as the app drives it, on whole files.
const read = (bytes: Uint8Array) => readOf(engine, bytes, layoutOf(engine, bytes));
const write = (bytes: Uint8Array, edit: WireEdit) => writeOf(engine, bytes, layoutOf(engine, bytes), edit);
const region = (bytes: Uint8Array) => layoutOf(engine, bytes).audio;

describe("the tag engine as wasm, on the fixtures", () => {
  it("has every case", () => {
    assert.ok(cases.length >= 26);
  });

  for (const fixture of cases) {
    describe(fixture.name, () => {
      const bytes = bytesOf(fixture.file);

      it("reads as cases.json says", () => {
        assert.equal(bytes.length, fixture.size);
        const layout = layoutOf(engine, bytes);
        assert.equal(layout.format, fixture.format);
        const tags = read(bytes);
        assert.equal(tags.format, fixture.format);
        assert.deepEqual(tags.fields, fixture.fields);
        if (fixture.cover) {
          assert.equal(tags.cover?.mime, fixture.cover.mime);
          assert.equal(sha1(tags.cover!.data), fixture.cover.sha1);
        } else {
          assert.equal(tags.cover, null);
        }
      });

      it("has its audio region", () => {
        const { start, end } = region(bytes);
        assert.deepEqual({ start, end }, { start: fixture.region.start, end: fixture.region.end });
        assert.equal(sha1(bytes.subarray(start, end)), fixture.region.sha1);
      });

      it(`saves a new title: ${fixture.write}`, () => {
        const save = () => write(bytes, { fields: { title: "New title" }, cover: keep });
        if (fixture.write !== "ok") {
          assert.throws(save, (error: unknown) => error instanceof TagError && error.code === fixture.write);
          return;
        }
        const out = save();
        const back = read(out);
        assert.deepEqual(back.fields, { ...fixture.fields, title: "New title" });
        const after = region(out);
        assert.equal(sha1(out.subarray(after.start, after.end)), fixture.region.sha1);
      });
    });
  }
});

describe("the tag engine as wasm", () => {
  const mp3 = bytesOf(cases.find((one) => one.name === "mp3-v23-padded")!.file);

  it("gives the same bytes back for an edit that changes nothing", () => {
    assert.deepEqual(write(mp3, { fields: {}, cover: keep }), mp3);
  });

  it("sets and removes the cover", () => {
    const cover = { mime: "image/png", data: Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 1, 2, 3) };
    const set = write(mp3, { fields: {}, cover: { set: cover } });
    assert.deepEqual(read(set).cover, cover);
    let file = set;
    while (read(file).cover) {
      file = write(file, { fields: {}, cover: { remove: true } });
    }
    assert.equal(read(file).fields.title, "Before");
  });

  it("refuses a year the tag cannot hold, by its code", () => {
    assert.throws(
      () => write(mp3, { fields: { year: "c. 1959" }, cover: keep }),
      (error: unknown) => error instanceof TagError && error.code === "invalid-year" && /c\. 1959/.test(error.message)
    );
  });

  it("gives no format for what is not MP3 or FLAC, and refuses to read it", () => {
    const other = Uint8Array.of(1, 2, 3);
    assert.deepEqual(layoutOf(engine, other), { format: null, tagsEnd: 0, audio: { start: 0, end: 3 } });
    assert.throws(() => read(other), (error: unknown) => error instanceof TagError && error.code === "not-supported");
  });

  it("never hands the module a file's audio, however large", () => {
    const large = new Uint8Array(mp3.length + 32 * 1024 * 1024);
    large.set(mp3);
    let largest = 0;
    const watched: Engine = {
      layout: (head, tail, length) => ((largest = Math.max(largest, head.length + tail.length)), engine.layout(head, tail, length)),
      read: (head, layout) => ((largest = Math.max(largest, head.length)), engine.read(head, layout)),
      write: (head, layout, edit) => ((largest = Math.max(largest, head.length)), engine.write(head, layout, edit)),
      get broken() {
        return engine.broken;
      }
    };
    const layout = layoutOf(watched, large);
    assert.equal(readOf(watched, large, layout).fields.title, "Before");
    const out = writeOf(watched, large, layout, { fields: { title: "Big" }, cover: keep });
    assert.equal(out.length, large.length);
    assert.deepEqual(out.subarray(layout.tagsEnd), large.subarray(layout.tagsEnd));
    assert.ok(largest <= 64 * 1024 + 160, `the module was given ${largest} bytes`);
  });

  it("follows a head that has to grow, past a large cover", () => {
    const cover = { mime: "image/jpeg", data: new Uint8Array(300_000).fill(7) };
    const covered = write(mp3, { fields: {}, cover: { set: cover } });
    const layout = layoutOf(engine, covered);
    assert.ok(layout.tagsEnd > 300_000);
    assert.deepEqual(read(covered).cover, cover);
  });

  it("refuses a splice that does not replace the tags it was given", () => {
    const layout = layoutOf(engine, mp3);
    const lying: Engine = { ...engine, layout: engine.layout, read: engine.read, write: (head, at, edit) => ({ ...engine.write(head, at, edit), replaceEnd: 1 }), broken: false };
    assert.throws(() => writeOf(lying, mp3, layout, { fields: { title: "X" }, cover: keep }), (error: unknown) => error instanceof TagError && error.code === "refused-audio");
  });
});
