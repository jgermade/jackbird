import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { track } from "./fixtures.test-support.ts";
import { buildWizardRows } from "./tree.ts";

const library = [
  track("Jazz/Miles/02 - Freddie.mp3", { title: "Freddie Freeloader", trackNumber: "2", artist: "Miles Davis" }, "t2"),
  track("Jazz/Miles/01 - So What.mp3", { title: "So What", trackNumber: "1", artist: "Miles Davis" }, "t1"),
  track("Jazz/Bill/01 - Peace Piece.mp3", { title: "", trackNumber: "1" }, "t3"),
  track("loose.mp3", { title: "Loose" }, "t4")
];

describe("buildWizardRows", () => {
  it("shows only the top folders, then root tracks, when nothing is expanded", () => {
    const rows = buildWizardRows(library, []);
    assert.deepEqual(
      rows.map((row) => [row.key, row.kind, row.depth, row.parentKey, row.expanded]),
      [
        ["folder:Jazz", "album", 0, null, false],
        ["track:t4", "track", 0, null, undefined]
      ]
    );
  });

  it("opens expanded folders, sorted, with their tracks after their subfolders", () => {
    const rows = buildWizardRows(library, ["Jazz", "Jazz/Miles"]);
    assert.deepEqual(
      rows.map((row) => row.key),
      ["folder:Jazz", "folder:Jazz/Bill", "folder:Jazz/Miles", "track:t1", "track:t2", "track:t4"]
    );
    const miles = rows.find((row) => row.key === "folder:Jazz/Miles");
    assert.deepEqual(miles, { key: "folder:Jazz/Miles", kind: "album", album: "Jazz/Miles", label: "Miles", expanded: true, parentKey: "folder:Jazz", depth: 1 });
  });

  it("describes a track row with its folder, number and artist", () => {
    const soWhat = buildWizardRows(library, ["Jazz", "Jazz/Miles"]).find((row) => row.trackId === "t1");
    assert.deepEqual(soWhat, {
      key: "track:t1",
      kind: "track",
      album: "Jazz/Miles",
      label: "So What",
      trackId: "t1",
      trackNumber: "1",
      artist: "Miles Davis",
      relativePath: "Jazz/Miles/01 - So What.mp3",
      parentKey: "folder:Jazz/Miles",
      depth: 2
    });
  });

  it("labels a track without a title by its file name", () => {
    const peace = buildWizardRows(library, ["Jazz", "Jazz/Bill"]).find((row) => row.trackId === "t3");
    assert.equal(peace?.label, "01 - Peace Piece.mp3");
  });

  it("does not open a folder whose parent is closed", () => {
    const rows = buildWizardRows(library, ["Jazz/Miles"]);
    assert.deepEqual(rows.map((row) => row.key), ["folder:Jazz", "track:t4"]);
  });

  it("is empty for no tracks", () => {
    assert.deepEqual(buildWizardRows([], ["Jazz"]), []);
  });
});
