import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { coverMime, coverName, coverRef, coverToDataUrl, dataUrlToCover, editFor, refName } from "./cover.ts";
import { emptyMetadata } from "./metadata.ts";

describe("coverToDataUrl and dataUrlToCover", () => {
  it("turn a picture into a data URL and back", () => {
    const cover = { mime: "image/png", data: Uint8Array.of(0, 1, 2, 250, 255) };
    const url = coverToDataUrl(cover);
    assert.equal(url, "data:image/png;base64,AAEC+v8=");
    assert.deepEqual(dataUrlToCover(url), cover);
  });

  it("handle a picture larger than one chunk", () => {
    const data = new Uint8Array(100_000).map((_, index) => index % 251);
    const back = dataUrlToCover(coverToDataUrl({ mime: "image/jpeg", data }));
    assert.deepEqual(back?.data, data);
  });

  it("call a picture without a MIME type a JPEG, either way", () => {
    assert.equal(coverToDataUrl({ mime: "", data: Uint8Array.of(1) }), "data:image/jpeg;base64,AQ==");
    assert.deepEqual(dataUrlToCover("data:;base64,AQ=="), { mime: "image/jpeg", data: Uint8Array.of(1) });
  });

  it("read a data URL with parameters before base64", () => {
    assert.deepEqual(dataUrlToCover("data:image/png;name=a.png;base64,AQ=="), { mime: "image/png", data: Uint8Array.of(1) });
  });

  it("give null for what is not a base64 data URL", () => {
    assert.equal(dataUrlToCover("https://example.com/a.jpg"), null);
    assert.equal(dataUrlToCover("data:image/png,raw"), null);
    assert.equal(dataUrlToCover("data:image/png;base64,***"), null);
  });
});

describe("editFor", () => {
  const before = { ...emptyMetadata(), title: "So What", trackNumber: "1", coverDataUrl: "data:image/png;base64,AQ==" };

  it("gives every field, the track number as the engine's track", () => {
    const edit = editFor(before, { ...before, title: "Freddie Freeloader", trackNumber: "2/5", genre: "" });
    assert.deepEqual(edit.fields, { title: "Freddie Freeloader", artist: "", album: "", year: "", genre: "", track: "2/5" });
  });

  it("gives the disc, the album artist and the compilation only when they change", () => {
    const edit = editFor({ ...before, discNumber: "1/2", albumArtist: "Various" }, { ...before, discNumber: "2/2", albumArtist: "Various", compilation: "1" });
    assert.deepEqual(edit.fields, { title: "So What", artist: "", album: "", year: "", genre: "", track: "1", disc: "2/2", compilation: "1" });
    assert.equal("albumArtist" in editFor(before, { ...before, albumArtist: "" }).fields, false);
    assert.equal(editFor({ ...before, discNumber: "1" }, { ...before, discNumber: "" }).fields.disc, "");
  });

  it("keeps the cover when it is the track's own", () => {
    assert.deepEqual(editFor(before, { ...before }).cover, { keep: true });
    assert.deepEqual(editFor(emptyMetadata(), emptyMetadata()).cover, { keep: true });
  });

  it("removes the cover when the form has none", () => {
    assert.deepEqual(editFor(before, { ...before, coverDataUrl: null }).cover, { remove: true });
  });

  it("sets a new cover, or keeps the old one when the new one is not a data URL", () => {
    assert.deepEqual(editFor(before, { ...before, coverDataUrl: "data:image/jpeg;base64,Ag==" }).cover, {
      set: { mime: "image/jpeg", data: Uint8Array.of(2) }
    });
    assert.deepEqual(editFor(before, { ...before, coverDataUrl: "blob:x" }).cover, { keep: true });
  });
});

describe("coverName", () => {
  // The same vectors as crates/api's cover_name test: both sides name a picture alike.
  it("names a picture by its bytes and its type", () => {
    assert.equal(coverName({ mime: "image/png", data: new Uint8Array([1, 2]) }), "ed74208a24b98405-2.png");
    assert.equal(coverName({ mime: "image/jpeg", data: new TextEncoder().encode("jackbird") }), "d79105f5ef3292ca-8.jpg");
  });
  it("takes a picture with no type as a JPEG, and an unknown type as an image", () => {
    assert.equal(coverName({ mime: "", data: new Uint8Array([]) }), "811c9dc55ad1e806-0.jpg");
    assert.match(coverName({ mime: "image/x-odd", data: new Uint8Array([7]) }), /\.img$/);
  });
  it("gives the same name to the same bytes, and another to others", () => {
    const one = coverName({ mime: "image/jpeg", data: new Uint8Array([1, 2, 3]) });
    assert.equal(coverName({ mime: "IMAGE/JPEG", data: new Uint8Array([1, 2, 3]) }), one);
    assert.notEqual(coverName({ mime: "image/jpeg", data: new Uint8Array([1, 2, 4]) }), one);
  });
});

describe("coverMime, coverRef and refName", () => {
  it("reads the type back from the name", () => {
    assert.equal(coverMime("ed74208a24b98405-2.png"), "image/png");
    assert.equal(coverMime("d79105f5ef3292ca-8.jpg"), "image/jpeg");
    assert.equal(coverMime("d79105f5ef3292ca-8.img"), "image/jpeg");
  });
  it("makes and reads a reference, and nothing else", () => {
    const name = "ed74208a24b98405-2.png";
    assert.equal(refName(coverRef(name)), name);
    assert.equal(refName("data:image/png;base64,AQI="), null);
    assert.equal(refName(null), null);
    assert.equal(refName(undefined), null);
    assert.equal(refName(coverRef("../../etc/passwd")), null);
  });
});
