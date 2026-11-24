import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_SHOWN, shownViewsOf, toggledView, viewShown } from "./shown-views.ts";

describe("the views shown", () => {
  it("shows every view but Artists until chosen", () => {
    assert.deepEqual(DEFAULT_SHOWN, ["files", "playlists", "albumsByArtist", "albums", "compilations"]);
    assert.deepEqual(shownViewsOf(null), DEFAULT_SHOWN);
    assert.deepEqual(shownViewsOf(undefined), DEFAULT_SHOWN);
  });

  it("reads the ones kept, known only, in their order; none reads as the default", () => {
    assert.deepEqual(shownViewsOf("albums, artists,songs,files"), ["files", "artists", "albums"]);
    assert.deepEqual(shownViewsOf(""), DEFAULT_SHOWN);
    assert.deepEqual(shownViewsOf("songs"), DEFAULT_SHOWN);
  });

  it("turns one on or off, never the last one off", () => {
    assert.deepEqual(toggledView(["files", "albums"], "artists", true), ["files", "artists", "albums"]);
    assert.deepEqual(toggledView(["files", "albums"], "files", false), ["albums"]);
    assert.deepEqual(toggledView(["albums"], "albums", false), ["albums"]);
  });

  it("lists a root in its view if shown, else the first shown", () => {
    assert.equal(viewShown("albums", ["files", "albums"]), "albums");
    assert.equal(viewShown("artists", ["playlists", "albums"]), "playlists");
    assert.equal(viewShown("artists", []), "artists");
  });
});
