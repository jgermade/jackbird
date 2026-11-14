import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { folded, isSendable, likelyDuplicates, songKey } from "./ipod.ts";

describe("sending to an iPod", () => {
  it("folds names: case, accents, spaces and punctuation aside", () => {
    assert.equal(folded("Don’t Stop Me Now"), "dontstopmenow");
    assert.equal(folded("Mañana"), "manana");
    assert.equal(folded("Électrique!"), "electrique");
    assert.equal(folded("東京"), "東京");
    assert.equal(folded(" - "), "");
    assert.equal(songKey({ title: "Blue Eyes", artist: "Elton John" }), songKey({ title: "blue eyes", artist: "ELTON JOHN" }));
  });

  it("finds the songs the iPod has already", () => {
    const existing = [
      { title: "Self Esteem", artist: "The Offspring" },
      { title: "Blue Eyes", artist: "Elton John" }
    ];
    const candidates = [
      { title: "self esteem", artist: "the offspring" },
      { title: "Bad Habit", artist: "The Offspring" },
      { title: "Blue Eyes", artist: "Someone Else" },
      { title: "Blue  Eyes!", artist: "Elton John" }
    ];
    assert.deepEqual(likelyDuplicates(candidates, existing), [0, 3]);
  });

  it("finds one file sent twice, and never a song without a title", () => {
    const twice = [
      { title: "One", artist: "A" },
      { title: "one", artist: "a" },
      { title: "", artist: "A" },
      { title: "", artist: "A" }
    ];
    assert.deepEqual(likelyDuplicates(twice, [{ title: "", artist: "A" }]), [1]);
    assert.deepEqual(likelyDuplicates([], []), []);
  });

  it("sends MP3s only", () => {
    assert.equal(isSendable("Rock/Song.mp3"), true);
    assert.equal(isSendable("Rock/Song.MP3"), true);
    assert.equal(isSendable("Rock/Song.flac"), false);
    assert.equal(isSendable("Rock/mp3"), false);
  });
});
