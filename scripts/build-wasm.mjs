#!/usr/bin/env node
// Builds the tag engine's WebAssembly module (crates/tags-wasm) into
// src/lib/tags/engine.wasm, which the web app loads lazily and the tests run
// the fixtures against. Run before `dev`, `test` and `build` (package.json);
// it does nothing when the module is newer than every file it is built from.
// Needs Rust stable with the wasm32-unknown-unknown target
// (`rustup target add wasm32-unknown-unknown`). See
// RECORD/2026-08-11.musikmatch-rust-migration.WIP.md (2026-11-07 20:16, E2-D3).

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(root, "src/lib/tags/engine.wasm");
const built = join(root, "target/wasm32-unknown-unknown/wasm/jackbird_tags_wasm.wasm");
const force = process.argv.includes("--force");

function newest(path) {
  const stat = statSync(path);
  if (!stat.isDirectory()) return stat.mtimeMs;
  return Math.max(0, ...readdirSync(path).map((name) => newest(join(path, name))));
}

const sources = Math.max(...["crates", "Cargo.toml", "Cargo.lock"].map((path) => newest(join(root, path))));
if (!force && existsSync(output) && statSync(output).mtimeMs >= sources) {
  process.exit(0);
}

const cargo = spawnSync(
  "cargo",
  ["build", "-p", "jackbird-tags-wasm", "--profile", "wasm", "--target", "wasm32-unknown-unknown", "--locked"],
  { cwd: root, stdio: "inherit" }
);
if (cargo.error || cargo.status !== 0) {
  console.error(
    cargo.error?.code === "ENOENT"
      ? "build-wasm: cargo was not found. The web app needs Rust stable and its wasm32-unknown-unknown target:\n" +
          "  https://rustup.rs, then `rustup target add wasm32-unknown-unknown`."
      : "build-wasm: the tag engine did not build (is the target installed? `rustup target add wasm32-unknown-unknown`)."
  );
  process.exit(1);
}
copyFileSync(built, output);
console.log(`build-wasm: src/lib/tags/engine.wasm (${(statSync(output).size / 1024).toFixed(1)} KB)`);
