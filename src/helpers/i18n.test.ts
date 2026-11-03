import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fill, pickLanguage, pluralCategory, translate, translatePlural } from "./i18n.ts";

const en = { "library.title": "Library", "tracks.count.one": "{count} track", "tracks.count.other": "{count} tracks", greeting: "Hello, {name}" };
const es = { "library.title": "Biblioteca", "tracks.count.one": "{count} pista", "tracks.count.other": "{count} pistas" };

describe("fill", () => {
  it("fills placeholders from params, numbers included", () => {
    assert.equal(fill("Back to {source}, track {position} of {total}", { source: "Music", position: 2, total: 9 }), "Back to Music, track 2 of 9");
  });

  it("leaves a placeholder with no value as written", () => {
    assert.equal(fill("Hello, {name}"), "Hello, {name}");
    assert.equal(fill("Hello, {name}", { other: "x" }), "Hello, {name}");
  });
});

describe("translate", () => {
  it("uses the language's message", () => {
    assert.equal(translate(es, en, "library.title"), "Biblioteca");
  });

  it("falls back to English, then to the key", () => {
    assert.equal(translate(es, en, "greeting", { name: "Ana" }), "Hello, Ana");
    assert.equal(translate(es, en, "missing.key"), "missing.key");
  });

  it("keeps an empty translation rather than falling back", () => {
    assert.equal(translate({ "library.title": "" }, en, "library.title"), "");
  });
});

describe("pluralCategory", () => {
  it("is one for 1 and other otherwise, in English and Spanish", () => {
    assert.equal(pluralCategory("en", 1), "one");
    assert.equal(pluralCategory("en", 0), "other");
    assert.equal(pluralCategory("es", 1), "one");
    assert.equal(pluralCategory("es", 7), "other");
  });
});

describe("translatePlural", () => {
  it("picks the category's message and fills the count", () => {
    assert.equal(translatePlural(es, en, "es", "tracks.count", 1), "1 pista");
    assert.equal(translatePlural(es, en, "es", "tracks.count", 3), "3 pistas");
    assert.equal(translatePlural(en, en, "en", "tracks.count", 0), "0 tracks");
  });

  it("falls back to the other form for a category the catalogue lacks", () => {
    assert.equal(translatePlural(es, en, "es", "tracks.count", 1_000_000), `${1_000_000} pistas`);
    assert.equal(translatePlural({ "x.other": "{count} x" }, {}, "en", "x", 1), "1 x");
  });

  it("passes extra params through", () => {
    assert.equal(translatePlural({ "n.other": "{count} in {where}" }, {}, "en", "n", 2, { where: "Jazz" }), "2 in Jazz");
  });
});

describe("pickLanguage", () => {
  const supported = ["en", "es"] as const;

  it("takes the first preferred language that is supported, by primary subtag", () => {
    assert.equal(pickLanguage(["es-ES", "en-US"], supported, "en"), "es");
    assert.equal(pickLanguage(["fr-FR", "ES-mx"], supported, "en"), "es");
    assert.equal(pickLanguage(["en-GB", "es"], supported, "en"), "en");
  });

  it("falls back when none is supported", () => {
    assert.equal(pickLanguage(["fr", "de-AT"], supported, "en"), "en");
    assert.equal(pickLanguage([], supported, "en"), "en");
  });
});
