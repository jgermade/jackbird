#!/usr/bin/env node
// Fails unless every helper is covered to the floor, file by file: lines,
// branches and functions. Node's own --test-coverage-* thresholds only see
// the total, and only the files a test loaded, so a helper nobody tests, or
// one well-tested file hiding a poor one, would pass them. This reads the
// LCOV report the unit tests write.
//
//   node scripts/check-coverage.mjs <lcov file> <floor %>
//
// See "Layers" in AGENTS.md and RECORD/2026-11-03.deck-design-system.WIP.md.

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [lcovPath = ".tmp/coverage/lcov.info", floorArg = "90"] = process.argv.slice(2);
const floor = Number(floorArg);
const HELPERS = "src/helpers";
const isHelper = (name) => name.endsWith(".ts") && !/\.test(-support)?\.ts$/.test(name) && !name.endsWith(".d.ts");

const records = new Map();
let current = null;
for (const line of readFileSync(resolve(root, lcovPath), "utf8").split("\n")) {
  const [key, value = ""] = line.split(":");
  if (key === "SF") {
    current = { path: relative(root, resolve(root, line.slice(3))).split(sep).join("/") };
    records.set(current.path, current);
  } else if (current && ["LF", "LH", "BRF", "BRH", "FNF", "FNH"].includes(key)) {
    current[key] = Number(value);
  }
}

const percent = (hit, found) => (found ? (hit / found) * 100 : 100);
const problems = [];
const helpers = readdirSync(join(root, HELPERS)).filter(isHelper).map((name) => `${HELPERS}/${name}`);

for (const path of helpers) {
  const record = records.get(path);
  if (!record) {
    problems.push(`${path}: no test loads it`);
    continue;
  }
  const metrics = {
    lines: percent(record.LH, record.LF),
    branches: percent(record.BRH, record.BRF),
    functions: percent(record.FNH, record.FNF)
  };
  for (const [metric, value] of Object.entries(metrics)) {
    if (value < floor) problems.push(`${path}: ${metric} ${value.toFixed(2)}% < ${floor}%`);
  }
}

if (problems.length > 0) {
  console.error(`Coverage check failed (every helper needs ${floor}% of lines, branches and functions):\n${problems.map((p) => `  ${p}`).join("\n")}`);
  process.exit(1);
}
console.log(`Coverage check passed: ${helpers.length} helpers at ${floor}% or more.`);
