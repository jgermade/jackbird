import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  addTo,
  clearPlayed,
  clearUpcoming,
  dropItems,
  hasQueued,
  jumpTo,
  markQueued,
  moveTo,
  playFrom,
  playNextIn,
  queueOf,
  queuedCount,
  removeAt,
  replaceWith,
  restoreQueue,
  sameItem,
  settle,
  shuffleUpcoming,
  type QueuePosition
} from "./queue.ts";

const item = (rootId: string, trackId: string) => ({ rootId, trackId });
const queued = (rootId: string, trackId: string) => ({ rootId, trackId, queued: true });
/** The parts after the current track: "q" for one queued on purpose, "s" for one suggested. */
const marks = (position: QueuePosition): string => position.queue?.items.slice(position.index + 1).map((one) => (one.queued ? "q" : "s")).join("") ?? "";
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
    assert.deepEqual(next, { queue: { items: [queued("talk", "x")], sourceLabel: "Talk" }, index: 0 });
  });

  it("changes nothing with no tracks", () => {
    assert.equal(playNextIn(playing, [], "x"), playing);
  });
});

describe("addTo", () => {
  it("puts tracks after the ones queued on purpose, before the suggested ones", () => {
    const next = addTo(playing, [item("talk", "x")], "ignored");
    assert.deepEqual(ids(next), ["music:a", "music:b", "talk:x", "music:c", "music:d"]);
    assert.equal(current(next), "music:b");
  });

  it("starts a queue when there is none, and changes nothing with no tracks", () => {
    assert.deepEqual(addTo({ queue: null, index: 0 }, [item("talk", "x")], "Talk"), { queue: { items: [queued("talk", "x")], sourceLabel: "Talk" }, index: 0 });
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

describe("the queued and the suggested parts", () => {
  it("queues on purpose: Play next first of the queued, Add to queue after them, both before the suggested", () => {
    const next = playNextIn(playing, [item("talk", "x")], "ignored");
    assert.equal(marks(next), "qss");
    const added = addTo(next, [item("talk", "y")], "ignored");
    assert.deepEqual(ids(added), ["music:a", "music:b", "talk:x", "talk:y", "music:c", "music:d"]);
    assert.equal(marks(added), "qqss");
    assert.equal(queuedCount(added), 2);
    assert.equal(queuedCount(playing), 0);
    assert.equal(queuedCount({ queue: null, index: 0 }), 0);
    const front = playNextIn(added, [item("talk", "z")], "ignored");
    assert.deepEqual(ids(front).slice(2, 5), ["talk:z", "talk:x", "talk:y"]);
  });

  it("tells a queue holding tracks put there on purpose, played ones too", () => {
    assert.equal(hasQueued(playing), false);
    assert.equal(hasQueued({ queue: null, index: 0 }), false);
    assert.equal(hasQueued({ queue: { items: [queued("m", "a"), item("m", "b")], sourceLabel: "" }, index: 1 }), true);
  });

  it("puts the queued ones first after the current track, and keeps a queue in order as it is", () => {
    const mixed: QueuePosition = { queue: { items: [item("m", "a"), item("m", "s1"), queued("m", "q1"), item("m", "s2"), queued("m", "q2")], sourceLabel: "" }, index: 0 };
    const sorted = settle(mixed);
    assert.deepEqual(ids(sorted), ["m:a", "m:q1", "m:q2", "m:s1", "m:s2"]);
    assert.equal(settle(sorted), sorted);
    assert.equal(settle({ queue: null, index: 0 }).queue, null);
  });

  it("jumps: forward, the tracks jumped over count as played; back, the ones after put in order", () => {
    const list: QueuePosition = { queue: { items: [item("m", "a"), item("m", "b"), queued("m", "q"), item("m", "s")], sourceLabel: "" }, index: 1 };
    const forward = jumpTo(list, 3);
    assert.equal(forward.index, 3);
    assert.equal(forward.queue, list.queue);
    const back = jumpTo(list, 0);
    assert.deepEqual(ids(back), ["m:a", "m:q", "m:b", "m:s"]);
    assert.equal(back.index, 0);
    assert.equal(jumpTo(list, 9), list);
    assert.equal(jumpTo({ queue: null, index: 0 }, 0).queue, null);
  });

  it("replaces the queue with a disc from a track: the ones before left out, the ones after suggested", () => {
    const disc = [queued("m", "1"), item("m", "2"), item("m", "3")];
    assert.deepEqual(replaceWith(disc, 1, "Disc"), { queue: { items: [item("m", "2"), item("m", "3")], sourceLabel: "Disc" }, index: 0 });
    assert.equal(replaceWith(disc, 5, "Disc").queue, null);
  });

  it("plays a disc keeping the queue: played and playing stay played, the queued ones after the disc's track, the old suggested ones gone", () => {
    const list: QueuePosition = { queue: { items: [item("m", "a"), item("m", "b"), queued("m", "q"), item("m", "s")], sourceLabel: "Old" }, index: 1 };
    const disc = [item("d", "1"), item("d", "2"), item("d", "3")];
    const next = playFrom(list, disc, 1, "Disc");
    assert.deepEqual(ids(next), ["m:a", "m:b", "d:2", "m:q", "d:3"]);
    assert.equal(current(next), "d:2");
    assert.equal(marks(next), "qs");
    assert.equal(next.queue?.sourceLabel, "Disc");
    assert.deepEqual(playFrom({ queue: null, index: 0 }, disc, 2, "Disc"), replaceWith(disc, 2, "Disc"));
    assert.equal(playFrom(list, disc, 7, "Disc"), list);
  });

  it("marks a track queued or suggested where it is, and moves one into the other part", () => {
    const list: QueuePosition = { queue: { items: [item("m", "a"), queued("m", "q"), item("m", "s1"), item("m", "s2")], sourceLabel: "" }, index: 0 };
    const up = markQueued(list, 2, true);
    assert.equal(marks(up), "qqs");
    assert.deepEqual(ids(up), ids(list));
    assert.equal(marks(markQueued(list, 1, false)), "sss");
    assert.equal(markQueued(list, 0, true), list);
    assert.equal(markQueued(list, 1, true), list);
    assert.equal(markQueued({ queue: null, index: 0 }, 1, true).queue, null);
    // The last suggested dragged among the queued (before the first of them), and a queued one onto a suggested one.
    const dragged = moveTo(list, 3, 1, true);
    assert.deepEqual(ids(dragged), ["m:a", "m:s2", "m:q", "m:s1"]);
    assert.equal(marks(dragged), "qqs");
    const down = moveTo(list, 1, 3, false);
    assert.deepEqual(ids(down), ["m:a", "m:s1", "m:s2", "m:q"]);
    assert.equal(marks(down), "sss");
    assert.equal(marks(moveTo(list, 2, 2, true)), "qqs");
    assert.equal(moveTo(list, 2, 2), list);
  });
});

describe("shuffleUpcoming", () => {
  it("mixes the tracks after the current one, all of them queued now, and drops the list's name", () => {
    const position: QueuePosition = { queue: queueOf("music", ["a", "b", "c", "d", "e"], "Jazz"), index: 1 };
    // Math.random's stand-in: always the first place, so each swap brings the front one back.
    const mixed = shuffleUpcoming(position, () => 0);
    assert.deepEqual(ids(mixed), ["music:a", "music:b", "music:d", "music:e", "music:c"]);
    assert.ok(mixed.queue?.items.slice(2).every((one) => one.queued && one.mixed));
    assert.equal(mixed.index, 1);
    assert.equal(current(mixed), "music:b");
    assert.equal(marks(mixed), "qqq");
    assert.equal(mixed.queue?.sourceLabel, "");
    assert.equal(position.queue?.sourceLabel, "Jazz");
  });

  it("keeps the ones queued on purpose first, in their order, and mixes only the rest", () => {
    // b playing; c and d put to play next; e, f and g suggested.
    const position: QueuePosition = {
      queue: { items: [item("music", "a"), item("music", "b"), queued("music", "c"), queued("music", "d"), item("music", "e"), item("music", "f"), item("music", "g")], sourceLabel: "Jazz" },
      index: 1
    };
    const mixed = shuffleUpcoming(position, () => 0);
    assert.deepEqual(ids(mixed), ["music:a", "music:b", "music:c", "music:d", "music:f", "music:g", "music:e"]);
    assert.equal(marks(mixed), "qqqqq");
    assert.equal(mixed.queue?.sourceLabel, "");
    // Pressed again: the mixed ones are mixed anew, the ones put there on purpose still first.
    const again = shuffleUpcoming(mixed, () => 0);
    assert.deepEqual(ids(again), ["music:a", "music:b", "music:c", "music:d", "music:g", "music:e", "music:f"]);
    assert.deepEqual(again.queue?.items.slice(2).map((one) => !!one.mixed), [false, false, true, true, true]);
    // One put to play next after a Shuffle keeps its place at the next.
    const added = playNextIn(again, [item("music", "h")], "");
    assert.deepEqual(ids(shuffleUpcoming(added, () => 0)).slice(2, 5), ["music:h", "music:c", "music:d"]);
  });

  it("keeps every track, and leaves no queue as none", () => {
    const mixed = shuffleUpcoming(playing);
    assert.deepEqual([...ids(mixed)].sort(), [...ids(playing)].sort());
    assert.deepEqual(ids(mixed).slice(0, 2), ids(playing).slice(0, 2));
    assert.deepEqual(shuffleUpcoming({ queue: null, index: -1 }), { queue: null, index: -1 });
  });
});
