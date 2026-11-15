#!/usr/bin/env node
// Builds the web app's WebAssembly modules: the tag engine (crates/tags-wasm) into
// src/lib/tags/engine.wasm, and the iPod's databases (crates/ipod-wasm) into
// src/lib/ipod-db/ipod.wasm. The web app loads each lazily, and the tests run the fixtures
// against them. Run before `dev`, `test` and `build` (package.json); a module newer than every
// file it is built from is not built again. Needs Rust stable with the wasm32-unknown-unknown
// target (`rustup target add wasm32-unknown-unknown`). See
// RECORD/2026-08-11.musikmatch-rust-migration.WIP.md (2026-11-07 20:16, E2-D3) and
// RECORD/2026-11-14.ipod-sync.WIP.md (W1).

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const force = process.argv.includes("--force");

/**
 * The modules. The tag engine is built for size (`wasm`: its work is copying memory); the iPod's
 * for speed (`wasm-speed`: it decodes and encodes covers, and performance comes first).
 */
const modules = [
  { crate: "jackbird-tags-wasm", file: "jackbird_tags_wasm.wasm", profile: "wasm", output: "src/lib/tags/engine.wasm" },
  { crate: "jackbird-ipod-wasm", file: "jackbird_ipod_wasm.wasm", profile: "wasm-speed", output: "src/lib/ipod-db/ipod.wasm" }
];

function newest(path) {
  const stat = statSync(path);
  if (!stat.isDirectory()) return stat.mtimeMs;
  return Math.max(0, ...readdirSync(path).map((name) => newest(join(path, name))));
}

const sources = Math.max(...["crates", "Cargo.toml", "Cargo.lock"].map((path) => newest(join(root, path))));

for (const module of modules) {
  const output = join(root, module.output);
  if (!force && existsSync(output) && statSync(output).mtimeMs >= sources) continue;
  const cargo = spawnSync(
    "cargo",
    ["build", "-p", module.crate, "--lib", "--profile", module.profile, "--target", "wasm32-unknown-unknown", "--locked"],
    { cwd: root, stdio: "inherit" }
  );
  if (cargo.error || cargo.status !== 0) {
    console.error(
      cargo.error?.code === "ENOENT"
        ? "build-wasm: cargo was not found. The web app needs Rust stable and its wasm32-unknown-unknown target:\n" +
            "  https://rustup.rs, then `rustup target add wasm32-unknown-unknown`."
        : `build-wasm: ${module.crate} did not build (is the target installed? \`rustup target add wasm32-unknown-unknown\`).`
    );
    process.exit(1);
  }
  copyFileSync(join(root, "target/wasm32-unknown-unknown", module.profile, module.file), output);
  console.log(`build-wasm: ${module.output} (${(statSync(output).size / 1024).toFixed(1)} KB)`);
}
