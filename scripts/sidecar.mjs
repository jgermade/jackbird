#!/usr/bin/env node
// The service's binary for the desktop app to carry (S2-D3): builds `jackbird-service` in release
// mode (with the web build embedded: run `npm run build` first) and copies it to
// src-tauri/binaries/jackbird-service-<target>, the name Tauri's `externalBin` expects. The
// bundle then has it beside the app's own binary. tauri.conf.json runs it before every build.
// See RECORD/2026-08-11.musikmatch-rust-migration.WIP.md (S2).

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const host = execFileSync("rustc", ["-vV"], { encoding: "utf8" }).match(/^host: (.+)$/m)?.[1];
if (!host) {
  console.error("sidecar: rustc did not say which system it builds for");
  process.exit(1);
}
execFileSync("cargo", ["build", "--release", "-p", "jackbird-service", "--locked"], { cwd: root, stdio: "inherit" });
const exe = process.platform === "win32" ? ".exe" : "";
const target = join(root, "src-tauri", "binaries", `jackbird-service-${host}${exe}`);
mkdirSync(dirname(target), { recursive: true });
copyFileSync(join(root, "target", "release", `jackbird-service${exe}`), target);
console.log(`sidecar: ${target}`);
