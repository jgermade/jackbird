import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RENAME_FIELDS, RENAME_PRESETS, completeField, fieldQuery, fieldsFor, fillPattern, inferredMetadata, planReads, planRenames, readTags, safeName, trackWidths } from "./rename.ts";

const track = (relativePath: string, metadata: Partial<{ title: string; artist: string; album: string; year: string; genre: string; trackNumber: string }> = {}) => ({
  id: relativePath,
  name: relativePath.split("/").pop() ?? relativePath,
  relativePath,
  metadata: { title: "", artist: "", album: "", year: "", genre: "", trackNumber: "", discNumber: "", albumArtist: "", compilation: "", composer: "", comment: "", lyrics: "", bpm: "", coverDataUrl: null, ...metadata }
});

const soWhat = track("Jazz/Kind of Blue/01 so what.mp3", { title: "So What", artist: "Miles Davis", album: "Kind of Blue", year: "1959", genre: "Jazz", trackNumber: "1/5" });

describe("fillPattern", () => {
  it("puts each field's value in its place", () => {
    assert.equal(fillPattern("%track% - %title%", soWhat), "01 - So What");
    assert.equal(fillPattern("%artist% - %album% (%year%) %genre%", soWhat), "Miles Davis - Kind of Blue (1959) Jazz");
    assert.equal(fillPattern("%filename% [%disc%]", soWhat), "01 so what [1]");
    assert.equal(fillPattern("%album_artist% - %album%", { ...soWhat, metadata: { ...soWhat.metadata, albumArtist: "Miles Davis Sextet" } }), "Miles Davis Sextet - Kind of Blue");
    assert.equal(fillPattern("%ALBUM_ARTIST%", soWhat), "");
  });

  it("pads the track number to the width it is given, and reads fields in any case", () => {
    assert.equal(fillPattern("%TRACK%", soWhat, 3), "001");
    assert.equal(fillPattern("%Title%", soWhat), "So What");
  });

  it("leaves an unknown field as typed, and an empty one empty", () => {
    assert.equal(fillPattern("%mood% %title%", soWhat), "%mood% So What");
    assert.equal(fillPattern("%track% - %title%", track("a.mp3")), " - ");
  });

  it("reads the disc from the folder", () => {
    assert.equal(fillPattern("%disc%-%track%", track("Album/Disc 2/a.mp3", { trackNumber: "4" })), "2-04");
  });
});

describe("trackWidths", () => {
  it("is the widest of each folder's totals and numbers, two at least", () => {
    const widths = trackWidths([
      track("A/1.mp3", { trackNumber: "3/12" }),
      track("B/1.mp3", { trackNumber: "7" }),
      track("C/1.mp3", { trackNumber: "100" }),
      track("C/2.mp3", { trackNumber: "4/9" }),
      track("D/1.mp3")
    ]);
    assert.deepEqual([...widths], [["A/", 2], ["B/", 2], ["C/", 3], ["D/", 2]]);
  });
});

describe("safeName", () => {
  it("replaces what a file name cannot hold, and trims", () => {
    assert.equal(safeName(' AC/DC: "Back" <In> Black? * | \\ '), 'AC_DC_ _Back_ _In_ Black_ _ _ _');
    assert.equal(safeName("tab\there\u0000"), "tab_here_");
    assert.equal(safeName("Trailing dots... "), "Trailing dots");
    assert.equal(safeName("  "), "");
  });
});

describe("planRenames", () => {
  const library = ["Album/01 - Intro.mp3", "Album/b.mp3", "Album/c.mp3", "Other/x.mp3"];

  it("gives each track its new path in its folder, with its extension", () => {
    const [plan] = planRenames([track("Album/b.mp3", { title: "Blue", trackNumber: "2/10" })], "%track% - %title%", library);
    assert.deepEqual(plan, { trackId: "Album/b.mp3", from: "Album/b.mp3", to: "Album/02 - Blue.mp3", name: "02 - Blue.mp3", shownFrom: "b.mp3", shown: "02 - Blue.mp3", status: "ok" });
  });

  it("says when nothing changes", () => {
    const [plan] = planRenames([track("Album/b.mp3", { title: "b" })], "%title%", library);
    assert.equal(plan.status, "same");
  });

  it("says when nothing is left of the name", () => {
    const [plan] = planRenames([track("Album/b.mp3")], "%title%", library);
    assert.equal(plan.status, "empty");
    assert.equal(plan.to, "Album/b.mp3");
    assert.equal(plan.name, "");
  });

  it("finds two tracks of the batch given one name, without case", () => {
    const plans = planRenames([track("Album/b.mp3", { title: "Same" }), track("Album/c.mp3", { title: "same" })], "%title%", library);
    assert.deepEqual(plans.map((plan) => plan.status), ["clash", "clash"]);
  });

  it("finds a name another track of the library has", () => {
    const [plan] = planRenames([track("Album/b.mp3", { title: "Intro", trackNumber: "1" })], "%track% - %title%", library);
    assert.equal(plan.status, "clash");
  });

  it("lets a track change only the case of its own name", () => {
    const [plan] = planRenames([track("Album/b.mp3", { title: "B" })], "%title%", library);
    assert.equal(plan.status, "ok");
    assert.equal(plan.to, "Album/B.mp3");
  });

  it("keeps the same name in two folders apart, and a name without an extension", () => {
    const plans = planRenames([track("Album/b.mp3", { title: "x" }), track("Other/y", { title: "z" })], "%title%", library);
    assert.deepEqual(plans.map((plan) => [plan.to, plan.status]), [["Album/x.mp3", "ok"], ["Other/z", "ok"]]);
  });

  it("offers the fields and the presets", () => {
    assert.ok(RENAME_FIELDS.includes("title"));
    assert.equal(RENAME_PRESETS[0], "%track% - %title%");
  });
});

describe("readTags: tags from a file's name", () => {
  it("reads a pattern's fields from the name, without its extension", () => {
    assert.deepEqual(readTags("%track% - %title%", track("Album/03 - So What.mp3")), { trackNumber: "3", title: "So What" });
    assert.deepEqual(readTags("%track%. %artist% - %title%", track("Album/7. Miles Davis - Blue in Green.flac")), {
      trackNumber: "7",
      artist: "Miles Davis",
      title: "Blue in Green"
    });
  });

  it("keeps the total a track had, and takes the text between the fields as it is", () => {
    assert.deepEqual(readTags("%track% - %title%", track("A/03 - Song.mp3", { trackNumber: "1/12" })), { trackNumber: "3/12", title: "Song" });
    assert.deepEqual(readTags("[%year%] (%album%) %title%", track("x/[1959] (Kind of Blue) So What.mp3")), { year: "1959", album: "Kind of Blue", title: "So What" });
    assert.deepEqual(readTags("%album_artist%/%album%/%title%", track("Miles Davis Sextet/Kind of Blue/So What.mp3")), { albumArtist: "Miles Davis Sextet", album: "Kind of Blue", title: "So What" });
  });

  it("reads the parent folders a pattern names with /, from the end of the path", () => {
    assert.deepEqual(readTags("%artist%/%album%/%track% - %title%", track("Music/Miles Davis/Kind of Blue/01 - So What.mp3")), {
      artist: "Miles Davis",
      album: "Kind of Blue",
      trackNumber: "1",
      title: "So What"
    });
    // Fewer folders than the pattern asks for: no match.
    assert.equal(readTags("%artist%/%album%/%title%", track("So What.mp3")), null);
  });

  it("does not match a name of another shape; digits fields take digits alone", () => {
    assert.equal(readTags("%track% - %title%", track("So What.mp3")), null);
    assert.equal(readTags("%track% - %title%", track("one - So What.mp3")), null);
    assert.equal(readTags("", track("01 - So What.mp3")), null);
  });

  it("reads nothing from %filename% or an unknown %word%", () => {
    assert.deepEqual(readTags("%filename%", track("So What.mp3")), {});
    assert.deepEqual(readTags("%foo% - %title%", track("x - So What.mp3")), { title: "So What" });
  });
});

describe("planReads", () => {
  it("marks what would change, what would not, and what does not match", () => {
    const tracks = [track("A/01 - New.mp3", { title: "Old", trackNumber: "1" }), track("A/02 - Same.mp3", { title: "Same", trackNumber: "2" }), track("A/Other.mp3")];
    const plans = planReads(tracks, "%track% - %title%");
    assert.deepEqual(plans.map((plan) => [plan.trackId, plan.status, plan.from]), [
      ["A/01 - New.mp3", "ok", "01 - New"],
      ["A/02 - Same.mp3", "same", "02 - Same"],
      ["A/Other.mp3", "nomatch", "Other"]
    ]);
    assert.deepEqual(plans[0].tags, { trackNumber: "1", title: "New" });
  });
});

describe("typing a field: fieldQuery, fieldsFor, completeField", () => {
  it("knows a field is being typed after an opening %, not after a closing one", () => {
    assert.deepEqual(fieldQuery("%", 1), { start: 0, query: "" });
    assert.deepEqual(fieldQuery("%track% - %ti", 13), { start: 10, query: "ti" });
    assert.equal(fieldQuery("%track%", 7), null);
    assert.equal(fieldQuery("%track% - ", 10), null);
    assert.equal(fieldQuery("100% sure", 9), null);
    assert.equal(fieldQuery("no field", 8), null);
  });

  it("offers the fields that begin with what is typed", () => {
    assert.deepEqual(fieldsFor(""), [...RENAME_FIELDS]);
    assert.deepEqual(fieldsFor("t"), ["title", "track"]);
    assert.deepEqual(fieldsFor("AR"), ["artist"]);
    assert.deepEqual(fieldsFor("al"), ["album", "album_artist"]);
    assert.deepEqual(fieldsFor("x"), []);
  });

  it("completes the field being typed, the caret after it", () => {
    assert.deepEqual(completeField("%track% - %ti", 13, "title"), { value: "%track% - %title%", caret: 17 });
    // Typed in the middle: the rest of a name and its closing % are replaced too.
    assert.deepEqual(completeField("%ar% - x", 3, "artist"), { value: "%artist% - x", caret: 8 });
    assert.deepEqual(completeField("%album_a", 8, "album_artist"), { value: "%album_artist%", caret: 14 });
    assert.deepEqual(completeField("plain", 5, "title"), { value: "plain", caret: 5 });
  });
});

describe("planRenames with /: the folders above the file", () => {
  const smash = (path: string, title: string, number: string) => track(path, { title, artist: "The Offspring", album: "Smash", trackNumber: number });

  it("names the folder the file is in, from the end of its path; the folders above stay", () => {
    const [plan] = planRenames([smash("Music/The Offspring - Smash/08-self_esteem.mp3", "Self Esteem", "8")], "%album%/%track% - %title%", []);
    assert.equal(plan.to, "Music/Smash/08 - Self Esteem.mp3");
    assert.equal(plan.shownFrom, "The Offspring - Smash/08-self_esteem.mp3");
    assert.equal(plan.shown, "Smash/08 - Self Esteem.mp3");
    assert.equal(plan.name, "08 - Self Esteem.mp3");
    assert.equal(plan.status, "ok");
  });

  it("makes the folders a file has fewer of, and makes each one's name safe", () => {
    const [plan] = planRenames([track("loose.mp3", { title: "One", artist: "AC/DC", album: "Live" })], "%artist%/%album%/%title%", []);
    assert.equal(plan.to, "AC_DC/Live/One.mp3");
    assert.equal(plan.shownFrom, "loose.mp3");
  });

  it("is empty when a folder's name would be, and finds clashes on the whole path", () => {
    const [empty] = planRenames([track("A/x.mp3", { title: "T" })], "%album%/%title%", []);
    assert.equal(empty.status, "empty");
    const plans = planRenames([smash("A/1.mp3", "Same", "1"), smash("B/2.mp3", "Same", "1")], "%album%/%track% - %title%", []);
    assert.deepEqual(plans.map((plan) => plan.status), ["clash", "clash"]);
  });

  it("keeps the file's folder without /, as before", () => {
    const [plan] = planRenames([smash("Music/Smash/x.mp3", "Self Esteem", "8")], "%track% - %title%", []);
    assert.equal(plan.to, "Music/Smash/08 - Self Esteem.mp3");
    assert.equal(plan.shown, "08 - Self Esteem.mp3");
    assert.equal(plan.shownFrom, "x.mp3");
  });
});

describe("the composer and the comment in patterns", () => {
  it("fills them, and reads them back from a name", () => {
    const piece = track("Classical/Bolero.mp3", { title: "Boléro", composer: "Ravel" } as never);
    assert.equal(fillPattern("%composer% - %title%", piece), "Ravel - Boléro");
    assert.deepEqual(readTags("%composer% - %title%", track("x/Ravel - Boléro.mp3")), { composer: "Ravel", title: "Boléro" });
  });
});

describe("tags guessed from a file's name, before they are read", () => {
  const guessed = (path: string) => {
    const { title, artist, album, trackNumber } = inferredMetadata(path);
    return { title, artist, album, trackNumber };
  };
  it("reads a number and a title", () => {
    assert.deepEqual(guessed("Music/FLAC/Metallica/1988/01 - Blackened.flac"), { title: "Blackened", artist: "", album: "", trackNumber: "1" });
    assert.deepEqual(guessed("x/02. Eye of the Beholder.mp3"), { title: "Eye of the Beholder", artist: "", album: "", trackNumber: "2" });
    assert.deepEqual(guessed("x/03 One.mp3"), { title: "One", artist: "", album: "", trackNumber: "3" });
  });
  it("reads an artist and a title", () => {
    assert.deepEqual(guessed("mp3/Amy Winehouse - Rehab.mp3"), { title: "Rehab", artist: "Amy Winehouse", album: "", trackNumber: "" });
  });
  it("takes the name as the title otherwise, and never the folders", () => {
    assert.deepEqual(guessed("Music/mp3/Blackened.mp3"), { title: "Blackened", artist: "", album: "", trackNumber: "" });
    assert.deepEqual(guessed("song"), { title: "song", artist: "", album: "", trackNumber: "" });
  });
});
