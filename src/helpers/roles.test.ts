import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assignable, atLeast, canManage } from "./roles.ts";

describe("roles", () => {
  it("each role includes the ones before it", () => {
    assert.equal(atLeast("owner", "listener"), true);
    assert.equal(atLeast("editor", "editor"), true);
    assert.equal(atLeast("editor", "admin"), false);
    assert.equal(atLeast("listener", "editor"), false);
    assert.equal(atLeast(null, "listener"), false);
    assert.equal(atLeast(undefined, "listener"), false);
  });

  it("admins manage editors and listeners, owners everyone", () => {
    assert.equal(canManage("admin", "editor"), true);
    assert.equal(canManage("admin", "listener"), true);
    assert.equal(canManage("admin", "admin"), false);
    assert.equal(canManage("admin", "owner"), false);
    assert.equal(canManage("owner", "owner"), true);
    assert.equal(canManage("editor", "listener"), false);
    assert.equal(canManage(null, "listener"), false);
  });

  it("says which roles each may give", () => {
    assert.deepEqual(assignable("owner"), ["listener", "editor", "admin", "owner"]);
    assert.deepEqual(assignable("admin"), ["listener", "editor"]);
    assert.deepEqual(assignable("editor"), []);
  });
});
