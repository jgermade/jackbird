// Puts the landing page together in a folder, for GitHub Pages (deploy.yml) or to look at locally:
// the page (landing/), and what it borrows from the app without copying it in the repository: the
// Deck theme's tokens and fonts, the logo and the screenshots.
//
//   node scripts/build-landing.mjs [out]      (default: .tmp/landing)
//
// deploy.yml puts the released app beside it, in <out>/demo/; the design system is the theme's
// specimen sheet in that build (<out>/demo/theme/default/), which <out>/design/ leads to.

import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(process.argv[2] ?? join(repo, ".tmp/landing"));

const copies = [
  ["landing", "."],
  ["theme/default/tokens.css", "theme/tokens.css"],
  ["theme/default/fonts.css", "theme/fonts.css"],
  ["theme/default/fonts", "theme/fonts"],
  ["src/assets/brand/jackbird-metal.svg", "brand/jackbird-metal.svg"],
  ["docs/screenshots", "screenshots"]
];

for (const [, to] of copies) rmSync(join(out, to === "." ? "index.html" : to), { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const [from, to] of copies) {
  cpSync(join(repo, from), join(out, to), { recursive: true });
}
console.log(`Landing page in ${out}`);
