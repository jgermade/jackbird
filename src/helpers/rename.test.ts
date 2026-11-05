import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RENAME_FIELDS, RENAME_PRESETS, fillPattern, planRenames, safeName, trackWidths } from "./rename.ts";

const track = (relativePath: string, metadata: Partial<{ title: string; artist: string; album: string; year: string; genre: string; trackNumber: string }> = {}) => ({
  id: relativePath,
  name: relativePath.split("/").pop() ?? relativePath,
  relativePath,
  metadata: { title: "", artist: "", album: "", year: "", genre: "", trackNumber: "", coverDataUrl: null, ...metadata }
});

const soWhat = track("Jazz/Kind of Blue/01 so what.mp3", { title: "So What", artist: "Miles Davis", album: "Kind of Blue", year: "1959", genre: "Jazz", trackNumber: "1/5" });

describe("fillPattern", () => {
  it("puts each field's value in its place", () => {
    assert.equal(fillPattern("%track% - %title%", soWhat), "01 - So What");
    assert.equal(fillPattern("%artist% - %album% (%year%) %genre%", soWhat), "Miles Davis - Kind of Blue (1959) Jazz");
    assert.equal(fillPattern("%filename% [%disc%]", soWhat), "01 so what [1]");
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
    assert.deepEqual(plan, { trackId: "Album/b.mp3", from: "Album/b.mp3", to: "Album/02 - Blue.mp3", name: "02 - Blue.mp3", status: "ok" });
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
