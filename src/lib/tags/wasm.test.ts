// The shared fixtures (fixtures/tags/, made by make.mjs) against the built
// module (src/lib/tags/engine.wasm, scripts/build-wasm.mjs, which `npm test`
// runs first): what reading each gives, its audio region, and what saving a
// new title gives. The same expectations `cargo test` checks natively.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
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

describe("the tag engine as wasm, on the fixtures", () => {
  it("has every case", () => {
    assert.ok(cases.length >= 26);
  });

  for (const fixture of cases) {
    describe(fixture.name, () => {
      const bytes = bytesOf(fixture.file);

      it("reads as cases.json says", () => {
        assert.equal(bytes.length, fixture.size);
        const tags = engine.read(bytes);
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
        const { start, end } = engine.region(bytes);
        assert.deepEqual({ start, end }, { start: fixture.region.start, end: fixture.region.end });
        assert.equal(sha1(bytes.subarray(start, end)), fixture.region.sha1);
      });

      it(`saves a new title: ${fixture.write}`, () => {
        const save = () => engine.write(bytes, { fields: { title: "New title" }, cover: keep });
        if (fixture.write !== "ok") {
          assert.throws(save, (error: unknown) => error instanceof TagError && error.code === fixture.write);
          return;
        }
        const out = save();
        const back = engine.read(out);
        assert.deepEqual(back.fields, { ...fixture.fields, title: "New title" });
        const region = engine.region(out);
        assert.equal(sha1(out.subarray(region.start, region.end)), fixture.region.sha1);
      });
    });
  }
});

describe("the tag engine as wasm", () => {
  const mp3 = bytesOf(cases.find((one) => one.name === "mp3-v23-padded")!.file);

  it("gives the same bytes back for an edit that changes nothing", () => {
    assert.deepEqual(engine.write(mp3, { fields: {}, cover: keep }), mp3);
  });

  it("sets and removes the cover", () => {
    const cover = { mime: "image/png", data: Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 1, 2, 3) };
    const set = engine.write(mp3, { fields: {}, cover: { set: cover } });
    assert.deepEqual(engine.read(set).cover, cover);
    let file = set;
    while (engine.read(file).cover) {
      file = engine.write(file, { fields: {}, cover: { remove: true } });
    }
    assert.equal(engine.read(file).fields.title, "Before");
  });

  it("refuses a year the tag cannot hold, by its code", () => {
    assert.throws(
      () => engine.write(mp3, { fields: { year: "c. 1959" }, cover: keep }),
      (error: unknown) => error instanceof TagError && error.code === "invalid-year" && /c\. 1959/.test(error.message)
    );
  });

  it("refuses what is not MP3 or FLAC", () => {
    assert.throws(() => engine.read(Uint8Array.of(1, 2, 3)), (error: unknown) => error instanceof TagError && error.code === "not-supported");
  });

  it("reads a large file, the memory grown on the way", () => {
    const large = new Uint8Array(mp3.length + 32 * 1024 * 1024);
    large.set(mp3);
    assert.equal(engine.read(large).fields.title, "Before");
    assert.equal(engine.write(large, { fields: { title: "Big" }, cover: keep }).length, large.length);
  });
});
