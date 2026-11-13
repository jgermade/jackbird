import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Density } from "../types.ts";
import { DEFAULT_DENSITY, DENSITIES, densityOf, rowHeights } from "./density.ts";

describe("densityOf", () => {
  it("takes a density it knows", () => {
    for (const density of DENSITIES) assert.equal(densityOf(density), density);
  });

  it("falls back to comfortable for anything else", () => {
    assert.equal(DEFAULT_DENSITY, "comfortable");
    assert.equal(densityOf(null), "comfortable");
    assert.equal(densityOf("huge"), "comfortable");
    assert.equal(densityOf(3), "comfortable");
  });
});

describe("rowHeights", () => {
  it("keeps compact at the rows' first heights", () => {
    assert.deepEqual(rowHeights("compact"), { row: 1.75, song: 2.25, queue: 3.5 });
  });

  it("grows every row from compact to spacious", () => {
    const [compact, comfortable, spacious] = DENSITIES.map(rowHeights);
    for (const key of ["row", "song", "queue"] as const) {
      assert.ok(compact[key] <= comfortable[key] && comfortable[key] <= spacious[key], key);
    }
    assert.ok(compact.row < comfortable.row && comfortable.row < spacious.row);
  });

  it("gives the default's heights for a density it does not know", () => {
    assert.deepEqual(rowHeights("huge" as Density), rowHeights("comfortable"));
  });
});
