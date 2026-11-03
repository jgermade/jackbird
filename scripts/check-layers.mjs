#!/usr/bin/env node
// Fails when an import crosses the layers the wrong way. The rules are the
// table in AGENTS.md ("Layers"). See RECORD/2026-11-03.deck-design-system.WIP.md.
//
// - helpers/    may import helpers/ only, and no package.
// - lib/        may import helpers/, lib/ and packages.
// - components/ (src/ and theme/default/) may import helpers/, components/
//               and the UI frameworks (react, jq79).
// - views/      may import anything.
//
// `src/types.ts` (types only) may be imported from anywhere, and so may any
// `import type`, which is erased before anything runs. Tests (*.test.ts and
// *.test-support.ts) may also import Node's built-ins (`node:…`).
// Files outside the four layers (entry points, src/services/ until it moves
// to lib/, the theme demo) are not checked.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FRAMEWORKS = new Set(["react", "react-dom", "jq79"]);
const SOURCE = /\.(ts|tsx|mts|js|mjs|html)$/;

const LAYERS = [
  ["helpers", "src/helpers/"],
  ["lib", "src/lib/"],
  ["components", "src/components/"],
  ["components", "theme/default/components/"],
  ["views", "src/views/"]
];

const layerOf = (path) => LAYERS.find(([, prefix]) => path.startsWith(prefix))?.[0] ?? null;
const isTest = (path) => /\.test(-support)?\.ts$/.test(path);
const isTypes = (path) => /^src\/types(\.ts)?$/.test(path) || path.endsWith(".d.ts");

const MAY_IMPORT = {
  helpers: new Set(["helpers"]),
  lib: new Set(["helpers", "lib"]),
  components: new Set(["helpers", "components"]),
  views: new Set(["helpers", "lib", "components", "views"])
};

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : SOURCE.test(name) ? [path] : [];
  });
}

// Static imports and re-exports (not `import type`), and dynamic `import("…")`,
// with the line each one is on.
function importsOf(text) {
  const found = [];
  const patterns = [
    /^\s*import\s+(?!type\b)(?:[\w$\s{},*]+?\s+from\s+)?["']([^"']+)["']/gm,
    /^\s*export\s+(?!type\b)[\w$\s{},*]+?\s+from\s+["']([^"']+)["']/gm,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const line = text.slice(0, match.index).split("\n").length;
      found.push({ specifier: match[1], line });
    }
  }
  return found;
}

const problems = [];
const files = ["src", "theme/default"].flatMap((dir) => walk(join(root, dir)));

for (const file of files) {
  const path = relative(root, file).split(sep).join("/");
  const layer = layerOf(path);
  if (!layer) continue;

  for (const { specifier, line } of importsOf(readFileSync(file, "utf8"))) {
    if (/\.(css|woff2?|svg|png|jpe?g)$/.test(specifier)) continue;

    if (!specifier.startsWith(".")) {
      const name = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
      const allowed =
        layer === "lib" || layer === "views" ||
        (layer === "components" && FRAMEWORKS.has(name)) ||
        (isTest(path) && specifier.startsWith("node:"));
      if (!allowed) problems.push(`${path}:${line}: ${layer}/ may not import the package "${specifier}"`);
      continue;
    }

    const target = relative(root, resolve(dirname(file), specifier)).split(sep).join("/");
    if (isTypes(target)) continue;
    const targetLayer = layerOf(target);
    if (!targetLayer || !MAY_IMPORT[layer].has(targetLayer)) {
      problems.push(`${path}:${line}: ${layer}/ may not import ${target} (${targetLayer ?? "outside the layers"})`);
    }
  }
}

if (problems.length > 0) {
  console.error(`Layer check failed (see "Layers" in AGENTS.md):\n${problems.map((p) => `  ${p}`).join("\n")}`);
  process.exit(1);
}
console.log(`Layer check passed: ${files.length} files.`);
