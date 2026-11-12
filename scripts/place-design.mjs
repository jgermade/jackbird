// Puts the design system (the Deck theme's specimen sheet, built with the app at
// demo/theme/default/) at the site's theme/default/, beside the landing page's own theme files:
// its page, its links to the build's assets pointed into demo/ (its scripts and styles stay where
// the build put them, so they find their chunks as they do there).
//
//   node scripts/place-design.mjs <site>      (after the build is copied to <site>/demo)
//
// See RECORD/2026-11-03.deck-design-system.WIP.md (2026-11-13 18:45).

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const site = resolve(process.argv[2] ?? "site");
const page = readFileSync(join(site, "demo/theme/default/index.html"), "utf8");
// From theme/default/, the build's assets are ../../demo/assets/ (they were ../../assets/).
const placed = page.replaceAll('"../../assets/', '"../../demo/assets/');
if (placed === page) throw new Error("place-design: the page links no ../../assets/: has the build changed?");
mkdirSync(join(site, "theme/default"), { recursive: true });
writeFileSync(join(site, "theme/default/index.html"), placed);
console.log(`Design system in ${join(site, "theme/default/")}`);
