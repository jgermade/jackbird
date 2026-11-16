import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { VFSAdapter } from "@cloudauthn/vfs-sync";
import { metaIn } from "./meta-in.ts";

/** A folder in memory that notes each call: its operation and path. */
function folder(): { vfs: VFSAdapter; calls: string[] } {
  const calls: string[] = [];
  const files = new Map<string, Uint8Array>([["Music/a.mp3", new Uint8Array([1])]]);
  const vfs: VFSAdapter = {
    name: "iPod",
    list: async (path) => (calls.push(`list ${path}`), []),
    read: async (path) => (calls.push(`read ${path}`), files.get(path) ?? new Uint8Array()),
    stat: async (path) => (calls.push(`stat ${path}`), null),
    write: async (path, data) => void (calls.push(`write ${path}`), files.set(path, data)),
    delete: async (path) => void calls.push(`delete ${path}`),
    rename: async (from, to) => void calls.push(`rename ${from} ${to}`),
    mkdir: async (path) => void calls.push(`mkdir ${path}`)
  };
  return { vfs, calls };
}

describe("a .meta/ kept elsewhere in its folder", () => {
  it("reads and writes .meta/ in its place", async () => {
    const { vfs, calls } = folder();
    const meta = metaIn(vfs, "iPod_Control/jackbird");
    await meta.write(".meta/mp3-manager.json", new Uint8Array([2]));
    await meta.read(".meta/mp3-manager.json");
    await meta.stat("/.meta/covers/x.png");
    await meta.mkdir!(".meta");
    await meta.rename(".meta/a", ".meta/b");
    await meta.delete(".meta/covers/x.png");
    assert.deepEqual(calls, [
      "write iPod_Control/jackbird/mp3-manager.json",
      "read iPod_Control/jackbird/mp3-manager.json",
      "stat iPod_Control/jackbird/covers/x.png",
      "mkdir iPod_Control/jackbird",
      "rename iPod_Control/jackbird/a iPod_Control/jackbird/b",
      "delete iPod_Control/jackbird/covers/x.png"
    ]);
    assert.equal(meta.name, "iPod");
  });

  it("reads anything else where it is, and writes nothing else", async () => {
    const { vfs, calls } = folder();
    const meta = metaIn(vfs, "iPod_Control/jackbird");
    assert.deepEqual(await meta.read("Music/a.mp3"), new Uint8Array([1]));
    await meta.list("Playlists");
    await assert.rejects(meta.write("Music/a.mp3", new Uint8Array()), { name: "NoModificationAllowedError" });
    await assert.rejects(meta.delete("Music/a.mp3"), { name: "NoModificationAllowedError" });
    await assert.rejects(meta.rename(".meta/a", "Music/a.mp3"), { name: "NoModificationAllowedError" });
    await assert.rejects(meta.write(".metadata/x", new Uint8Array()), { name: "NoModificationAllowedError" });
    assert.deepEqual(calls, ["read Music/a.mp3", "list Playlists"]);
  });

  it("has no mkdir where its folder has none", () => {
    const { vfs } = folder();
    delete vfs.mkdir;
    assert.equal(metaIn(vfs, "x").mkdir, undefined);
  });
});
