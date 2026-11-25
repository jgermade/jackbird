import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { newTrackId, uuidOf, withTrackId } from "./track-id.ts";

describe("a track id", () => {
  it("is a UUID v4", () => {
    assert.equal(uuidOf(new Uint8Array(16)), "00000000-0000-4000-8000-000000000000");
    assert.equal(uuidOf(new Uint8Array(16).fill(0xff)), "ffffffff-ffff-4fff-bfff-ffffffffffff");
    assert.match(newTrackId(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.notEqual(newTrackId(), newTrackId());
    assert.throws(() => uuidOf(new Uint8Array(4)));
  });

  it("is given once: the one written, else the file's, else a new one", () => {
    const make = () => "new";
    const given: { title: string; jackbirdTrackId?: string } = { title: "a", jackbirdTrackId: "mine" };
    const none: { title: string; jackbirdTrackId?: string } = { title: "a" };
    const emptied: { title: string; jackbirdTrackId?: string } = { title: "a", jackbirdTrackId: "" };
    assert.equal(withTrackId(given, { jackbirdTrackId: "file" }, make).jackbirdTrackId, "mine");
    assert.equal(withTrackId(none, { jackbirdTrackId: "file" }, make).jackbirdTrackId, "file");
    assert.equal(withTrackId(none, {}, make).jackbirdTrackId, "new");
    assert.equal(withTrackId(emptied, {}, make).title, "a");
    assert.equal(withTrackId(emptied, {}, make).jackbirdTrackId, "new");
  });
});
