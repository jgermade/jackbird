import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { addTo, clearPlayed, clearUpcoming, dropItems, isOneAlbum, moveTo, playNextIn, queueOf, removeAt, restoreQueue, sameItem, type QueuePosition } from "./queue.ts";

const item = (rootId: string, trackId: string) => ({ rootId, trackId });
const ids = (position: QueuePosition): string[] => position.queue?.items.map((one) => `${one.rootId}:${one.trackId}`) ?? [];
const current = (position: QueuePosition): string | null => (position.queue ? ids(position)[position.index] : null);

/** Music's a, b, c, d, the second one playing. */
const playing: QueuePosition = { queue: queueOf("music", ["a", "b", "c", "d"], "Jazz"), index: 1 };

describe("queueOf and sameItem", () => {
  it("makes a queue of one root's tracks, in order", () => {
    assert.deepEqual(queueOf("music", ["a", "b"], "Jazz"), { items: [item("music", "a"), item("music", "b")], sourceLabel: "Jazz" });
  });

  it("tells the same track of the same root", () => {
    assert.equal(sameItem(item("music", "a"), item("music", "a")), true);
    assert.equal(sameItem(item("music", "a"), item("talk", "a")), false);
    assert.equal(sameItem(item("music", "a"), item("music", "b")), false);
  });
});

describe("playNextIn", () => {
  it("puts tracks right after the current one, in their order, from any root", () => {
    const next = playNextIn(playing, [item("talk", "x"), item("talk", "y")], "ignored");
    assert.deepEqual(ids(next), ["music:a", "music:b", "talk:x", "talk:y", "music:c", "music:d"]);
    assert.equal(current(next), "music:b");
    assert.equal(next.queue?.sourceLabel, "Jazz");
  });

  it("starts a queue when there is none, the first track current", () => {
    const next = playNextIn({ queue: null, index: 0 }, [item("talk", "x")], "Talk");
    assert.deepEqual(next, { queue: { items: [item("talk", "x")], sourceLabel: "Talk" }, index: 0 });
  });

  it("changes nothing with no tracks", () => {
    assert.equal(playNextIn(playing, [], "x"), playing);
  });
});

describe("addTo", () => {
  it("puts tracks at the end", () => {
    const next = addTo(playing, [item("talk", "x")], "ignored");
    assert.deepEqual(ids(next), ["music:a", "music:b", "music:c", "music:d", "talk:x"]);
    assert.equal(current(next), "music:b");
  });

  it("starts a queue when there is none, and changes nothing with no tracks", () => {
    assert.deepEqual(addTo({ queue: null, index: 0 }, [item("talk", "x")], "Talk"), { queue: { items: [item("talk", "x")], sourceLabel: "Talk" }, index: 0 });
    assert.equal(addTo(playing, [], "x"), playing);
  });
});

describe("removeAt", () => {
  it("removes a track after the current one", () => {
    const next = removeAt(playing, 2);
    assert.deepEqual(ids(next), ["music:a", "music:b", "music:d"]);
    assert.equal(current(next), "music:b");
  });

  it("removes a track before the current one, which stays current", () => {
    const next = removeAt(playing, 0);
    assert.deepEqual(ids(next), ["music:b", "music:c", "music:d"]);
    assert.equal(next.index, 0);
    assert.equal(current(next), "music:b");
  });

  it("does not remove the current track, or one that is not there", () => {
    assert.equal(removeAt(playing, 1), playing);
    assert.equal(removeAt(playing, 9), playing);
    assert.equal(removeAt(playing, -1), playing);
    assert.deepEqual(removeAt({ queue: null, index: 0 }, 0), { queue: null, index: 0 });
  });
});

describe("moveTo", () => {
  it("moves the current track, which stays current", () => {
    const next = moveTo(playing, 1, 3);
    assert.deepEqual(ids(next), ["music:a", "music:c", "music:d", "music:b"]);
    assert.equal(current(next), "music:b");
  });

  it("moves a track from before the current one to after it", () => {
    const next = moveTo(playing, 0, 2);
    assert.deepEqual(ids(next), ["music:b", "music:c", "music:a", "music:d"]);
    assert.equal(current(next), "music:b");
  });

  it("moves a track from after the current one to before it", () => {
    const next = moveTo(playing, 3, 0);
    assert.deepEqual(ids(next), ["music:d", "music:a", "music:b", "music:c"]);
    assert.equal(current(next), "music:b");
  });

  it("moves a track on one side of the current one", () => {
    const next = moveTo(playing, 3, 2);
    assert.deepEqual(ids(next), ["music:a", "music:b", "music:d", "music:c"]);
    assert.equal(current(next), "music:b");
  });

  it("changes nothing for no move, or a place that is not there", () => {
    assert.equal(moveTo(playing, 2, 2), playing);
    assert.equal(moveTo(playing, 2, 7), playing);
    assert.equal(moveTo(playing, -1, 0), playing);
    assert.deepEqual(moveTo({ queue: null, index: 0 }, 0, 1), { queue: null, index: 0 });
  });
});

describe("clearUpcoming", () => {
  it("keeps the queue up to the current track", () => {
    const next = clearUpcoming(playing);
    assert.deepEqual(ids(next), ["music:a", "music:b"]);
    assert.equal(current(next), "music:b");
    assert.deepEqual(clearUpcoming({ queue: null, index: 0 }), { queue: null, index: 0 });
  });
});

describe("clearPlayed", () => {
  it("keeps the queue from the current track on", () => {
    const next = clearPlayed(playing);
    assert.deepEqual(ids(next), ["music:b", "music:c", "music:d"]);
    assert.equal(current(next), "music:b");
    assert.deepEqual(clearPlayed({ queue: null, index: 0 }), { queue: null, index: 0 });
  });
});

describe("dropItems", () => {
  const mixed: QueuePosition = { queue: { items: [item("music", "a"), item("talk", "x"), item("music", "b"), item("talk", "y"), item("music", "c")], sourceLabel: "Mix" }, index: 2 };

  it("drops a root's tracks; the current one stays current", () => {
    const next = dropItems(mixed, (one) => one.rootId === "talk");
    assert.deepEqual(ids(next), ["music:a", "music:b", "music:c"]);
    assert.equal(current(next), "music:b");
    assert.equal(next.currentGone, false);
  });

  it("makes the next one that stays current when the current one goes", () => {
    const next = dropItems({ ...mixed, index: 1 }, (one) => one.rootId === "talk");
    assert.equal(current(next), "music:b");
    assert.equal(next.currentGone, true);
  });

  it("makes the last one current when nothing after the current one stays", () => {
    const next = dropItems({ ...mixed, index: 3 }, (one) => one.rootId === "talk" || one.trackId === "c");
    assert.deepEqual(ids(next), ["music:a", "music:b"]);
    assert.equal(current(next), "music:b");
    assert.equal(next.currentGone, true);
  });

  it("is null when nothing stays, and the same when nothing goes", () => {
    const none = dropItems(mixed, () => true);
    assert.equal(none.queue, null);
    assert.equal(none.currentGone, true);
    const all = dropItems(mixed, () => false);
    assert.equal(all.queue, mixed.queue);
    assert.equal(all.currentGone, false);
    assert.deepEqual(dropItems({ queue: null, index: 0 }, () => true), { queue: null, index: 0, currentGone: false });
  });
});

describe("restoreQueue", () => {
  const mixed: QueuePosition = { queue: { items: [item("music", "a"), item("talk", "x"), item("music", "b")], sourceLabel: "Mix" }, index: 2 };

  it("keeps the items whose roots reopened, the same track current", () => {
    const back = restoreQueue(mixed, new Set(["music"]));
    assert.deepEqual(back && ids(back), ["music:a", "music:b"]);
    assert.equal(back && current(back), "music:b");
    assert.deepEqual(restoreQueue(mixed, new Set(["music", "talk"])), { queue: mixed.queue, index: 2 });
  });

  it("is null when the current track's root did not reopen, or there is nothing", () => {
    assert.equal(restoreQueue(mixed, new Set(["talk"])), null);
    assert.equal(restoreQueue({ queue: null, index: 0 }, new Set(["music"])), null);
    assert.equal(restoreQueue({ ...mixed, index: 9 }, new Set(["music"])), null);
  });
});

describe("isOneAlbum", () => {
  const part = (album: string, artist: string, folder = "r/Black Album") => ({ album, artist, folder });
  it("is a disc when every track is of one named album, by one artist or in one folder", () => {
    assert.equal(isOneAlbum([part("Metallica", "Metallica"), part("metallica ", "Metallica", "r/other")]), true);
    // A compilation: several artists, one folder.
    assert.equal(isOneAlbum([part("Hits", "A"), part("Hits", "B")]), true);
  });
  it("is a list otherwise", () => {
    assert.equal(isOneAlbum([part("Metallica", "Metallica"), part("Load", "Metallica")]), false);
    assert.equal(isOneAlbum([part("Hits", "A", "r/one"), part("Hits", "B", "r/two")]), false);
    assert.equal(isOneAlbum([part("", "A"), part("", "A")]), false);
    assert.equal(isOneAlbum([part("Hits", "A"), null]), false);
    assert.equal(isOneAlbum([part("Hits", "A")]), false);
    assert.equal(isOneAlbum([]), false);
  });
});
