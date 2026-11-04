#!/usr/bin/env node
// Fails on a scoped style that jq79 would lose. jq79 scopes a component's
// styles by parsing them into a CSSOM sheet and writing the rules back out as
// text, and Chromium serializes a shorthand that holds a `var()` and is then
// partly overridden in the same block as empty longhands
// (`border-top-style: ;`): the shorthand is gone. So in a block, a shorthand
// with `var()` must not be followed by one of its own longhands; write the
// longhands instead. See RECORD/2026-11-04.github-actions-workflows.WIP.md
// (11:36).
//
// Checks the `<style>` blocks of every `.html` jq79 component and view
// under src/ and theme/ (the pages, `index.html`, are plain HTML, not
// scoped).

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Each shorthand and a test for its longhands. `border-radius`,
// `outline-offset` and the like are not longhands of `border` or `outline`.
const SIDES = ["top", "right", "bottom", "left", "block", "block-start", "block-end", "inline", "inline-start", "inline-end"];
const isBorderPart = (prop) => /^border-/.test(prop) && !/radius|collapse|spacing/.test(prop);
const SHORTHANDS = {
  font: (prop) => prop.startsWith("font-") || prop === "line-height",
  border: isBorderPart,
  ...Object.fromEntries(SIDES.map((side) => [`border-${side}`, (prop) => prop.startsWith(`border-${side}-`) && isBorderPart(prop)])),
  "border-width": (prop) => /^border-.+-width$/.test(prop),
  "border-style": (prop) => /^border-.+-style$/.test(prop),
  "border-color": (prop) => /^border-.+-color$/.test(prop),
  "border-radius": (prop) => /^border-.+-radius$/.test(prop),
  background: (prop) => prop.startsWith("background-"),
  margin: (prop) => prop.startsWith("margin-"),
  padding: (prop) => prop.startsWith("padding-"),
  inset: (prop) => ["top", "right", "bottom", "left"].includes(prop) || prop.startsWith("inset-"),
  outline: (prop) => ["outline-color", "outline-style", "outline-width"].includes(prop),
  transition: (prop) => prop.startsWith("transition-"),
  animation: (prop) => prop.startsWith("animation-"),
  flex: (prop) => ["flex-grow", "flex-shrink", "flex-basis"].includes(prop),
  "grid-template": (prop) => prop.startsWith("grid-template-"),
  gap: (prop) => prop === "row-gap" || prop === "column-gap",
  "list-style": (prop) => prop.startsWith("list-style-"),
  "text-decoration": (prop) => prop.startsWith("text-decoration-"),
  columns: (prop) => prop === "column-width" || prop === "column-count",
  overflow: (prop) => prop === "overflow-x" || prop === "overflow-y"
};

function* htmlFiles(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      yield* htmlFiles(path);
    } else if (name.endsWith(".html") && name !== "index.html") {
      yield path;
    }
  }
}

/** Every innermost `selector { declarations }` block of a style text, comments removed. */
function* blocks(css) {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const match of text.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    const declarations = match[2]
      .split(";")
      .map((part) => part.trim())
      .filter((part) => part.includes(":"))
      .map((part) => {
        const at = part.indexOf(":");
        return { prop: part.slice(0, at).trim().toLowerCase(), value: part.slice(at + 1).trim() };
      });
    yield { selector: match[1].trim().replace(/\s+/g, " "), declarations };
  }
}

const problems = [];
for (const base of ["src", "theme"]) {
  for (const file of htmlFiles(join(root, base))) {
    const source = readFileSync(file, "utf8");
    for (const style of source.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)) {
      for (const { selector, declarations } of blocks(style[1])) {
        declarations.forEach((shorthand, index) => {
          const isLonghand = SHORTHANDS[shorthand.prop];
          if (!isLonghand || !shorthand.value.includes("var(")) return;
          for (const later of declarations.slice(index + 1)) {
            if (isLonghand(later.prop)) {
              problems.push(`${relative(root, file)}: ${selector} { ${shorthand.prop}: ${shorthand.value}; … ${later.prop}: ${later.value} }`);
            }
          }
        });
      }
    }
  }
}

if (problems.length > 0) {
  console.error("A shorthand with var() is overridden by its own longhand in the same block; jq79's scoping would drop it. Write the longhands:");
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}
console.log("Style check passed: no var() shorthand overridden in its own block.");
