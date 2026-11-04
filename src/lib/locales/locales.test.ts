import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { en } from "./en.ts";
import { es } from "./es.ts";

const placeholders = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
const catalogues = { es };

describe("locales", () => {
  for (const [language, messages] of Object.entries(catalogues)) {
    it(`${language} has every English key and no other`, () => {
      assert.deepEqual(Object.keys(messages).sort(), Object.keys(en).sort());
    });

    it(`${language} uses the same placeholders as English`, () => {
      for (const [key, source] of Object.entries(en)) {
        assert.deepEqual(placeholders(messages[key as keyof typeof en]), placeholders(source), key);
      }
    });

    it(`${language} names itself`, () => {
      assert.notEqual(messages["language.self"], en["language.self"]);
    });
  }

  it("gives every counted key both forms", () => {
    for (const key of Object.keys(en)) {
      if (key.endsWith(".one")) assert.ok(`${key.slice(0, -4)}.other` in en, key);
    }
  });
});
