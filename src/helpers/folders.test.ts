import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { WizardTreeRow } from "../types.ts";
import { foldersWithSubfolders, withoutSongs } from "./folders.ts";

const at = (relativePath: string) => ({ relativePath });

describe("foldersWithSubfolders", () => {
  it("lists every folder that holds another", () => {
    assert.deepEqual(
      [...foldersWithSubfolders([at("Jazz/Miles/Kind of Blue/01.mp3"), at("Jazz/Miles/02.mp3"), at("Rock/03.mp3"), at("loose.mp3")])].sort(),
      ["Jazz", "Jazz/Miles"]
    );
  });
});

describe("withoutSongs", () => {
  const folder = (album: string, depth: number, expanded = true): WizardTreeRow => ({ key: album, kind: "album", album, label: album, parentKey: null, depth, expanded });
  const song = (id: string, depth: number): WizardTreeRow => ({ key: id, kind: "track", album: "", label: id, parentKey: null, depth, trackId: id });
  const disc: WizardTreeRow = { key: "disc", kind: "disc", album: "Jazz/Miles/Kind of Blue", label: "Disc 1", parentKey: null, depth: 3 };
  const tracks = [at("Jazz/Miles/Kind of Blue/01.mp3"), at("Jazz/Miles/02.mp3")];
  const files = [folder("Jazz", 0), folder("Jazz/Miles", 1), folder("Jazz/Miles/Kind of Blue", 2), disc, song("Jazz/Miles/Kind of Blue/01.mp3", 3), song("Jazz/Miles/02.mp3", 2)];

  it("keeps the folders only, a folder with none under it a leaf, closed", () => {
    const rows = withoutSongs(files, "files", tracks);
    assert.deepEqual(
      rows.map((row) => [row.key, row.leaf, row.expanded]),
      [
        ["Jazz", false, true],
        ["Jazz/Miles", false, true],
        ["Jazz/Miles/Kind of Blue", true, false]
      ]
    );
  });

  it("makes an artist of Album artists hold its albums, and every other view's group a leaf", () => {
    const groups = [folder("@aba:Miles", 0), folder("@aba:Miles::Kind of Blue", 1), song("01.mp3", 2)];
    assert.deepEqual(withoutSongs(groups, "albumsByArtist", tracks).map((row) => row.leaf), [false, true]);
    assert.deepEqual(withoutSongs([folder("@album:Kind of Blue", 0), song("01.mp3", 1)], "albums", tracks).map((row) => [row.leaf, row.expanded]), [[true, false]]);
  });

  it("leaves the Songs view as it is", () => {
    const songs = [song("a.mp3", 0), song("b.mp3", 0)];
    assert.deepEqual(withoutSongs(songs, "songs", tracks), songs);
  });
});
