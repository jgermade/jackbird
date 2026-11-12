#!/usr/bin/env node
// The desktop app's unattended check (E4-D8): copies the tag fixtures to a
// new folder, starts the built app on it (JACKBIRD_CHECK_FOLDER), and checks
// its report (src/lib/sources/check.ts): every track found and read, a title
// saved and read back with the audio kept, an MP3 and a FLAC played, and a 24/96
// FLAC through the native player (E5). Run by
// desktop.yml on Linux (under xvfb-run), macOS and Windows:
//
//   node scripts/desktop-check.mjs target/release/jackbird
//
// Exits non-zero, with the report, when something is missing. See
// RECORD/2026-08-11.musikmatch-rust-migration.WIP.md (E4).

import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const binary = resolve(process.argv[2] ?? "target/release/jackbird");
const folder = mkdtempSync(join(tmpdir(), "jackbird-check-"));
const fixtures = resolve("fixtures/tags");
const audio = readdirSync(fixtures).filter((name) => /\.(mp3|flac)$/i.test(name));
for (const name of audio) cpSync(join(fixtures, name), join(folder, name));
// A 24/96 FLAC for the native player (E5).
cpSync(resolve("fixtures/audio/flac-24-96.flac"), join(folder, "hires-24-96.flac"));
audio.push("hires-24-96.flac");
const reportPath = join(folder, "report.json");

/** Runs the app once with these variables; its report. */
async function run(variables, report) {
  rmSync(report, { force: true });
  const app = spawn(binary, [], { env: { ...process.env, ...variables, JACKBIRD_CHECK_REPORT: report }, stdio: "inherit" });
  const timer = setTimeout(() => app.kill(), 120_000);
  await new Promise((done) => app.on("exit", done));
  clearTimeout(timer);
  if (!existsSync(report)) {
    console.error("desktop-check: no report (the app did not finish the check in 2 minutes)");
    process.exit(1);
  }
  return JSON.parse(readFileSync(report, "utf8"));
}

const report = await run({ JACKBIRD_CHECK_FOLDER: folder }, reportPath);
console.log(JSON.stringify(report, null, 2));
// Started again: the session reopens the folder.
const restored = await run({ JACKBIRD_CHECK_RESTORE: "1" }, reportPath);
console.log(JSON.stringify(restored, null, 2));
const problems = [];
if (report.error) problems.push(`error: ${report.error}`);
if (report.tracks !== audio.length) problems.push(`tracks: ${report.tracks} of ${audio.length}`);
if (report.titles?.["mp3-v23-padded.mp3"] !== "Before") problems.push("mp3-v23-padded.mp3 does not read as Before");
if (report.save?.title !== "Checked by the desktop app" || !report.save?.audioKept) problems.push("the save did not read back, or changed the audio");
for (const extension of [".mp3", ".flac"]) {
  const played = report.played?.[extension];
  if (!played || played.error || !(played.played > 0)) problems.push(`${extension} did not play: ${JSON.stringify(played)}`);
}
// The native player (E5): it played the 24/96 FLAC, or said why not (a runner may have no sound card).
const native = report.native;
if (!native) problems.push("the native player was not tried");
else if (!native.failed && !(native.started && (native.position > 0 || native.ended))) problems.push(`the native player neither played nor said why: ${JSON.stringify(native)}`);
else if (process.env.JACKBIRD_CHECK_NATIVE === "required" && native.failed) problems.push(`the native player did not play: ${native.failed}`);
const shown = (holding) => (holding ?? []).find((root) => root.path === folder);
// With the service installed (S2), the app is its interface: its roots are the service's.
const kind = process.env.JACKBIRD_CHECK_KIND ?? "desktop";
if (shown(report.library)?.kind !== kind) problems.push(`the root is ${shown(report.library)?.kind}, not ${kind}`);
if (shown(report.library)?.tracks !== audio.length) problems.push(`the library shows ${JSON.stringify(report.library)}`);
// Back at its size: the whole window's, title bar and all (its inside is not the same measure
// with and without the bar on macOS).
const near = (a, b) => typeof a === "number" && typeof b === "number" && Math.abs(a - b) <= 2;
const backAtSize = (after, before) => near(after?.outerWidth, before?.outerWidth) && near(after?.outerHeight, before?.outerHeight);
// The compact mode (C2): the window turned small and bare, and back to its size and its title bar.
const compact = report.compact ?? {};
if (compact.error) problems.push(`compact mode: ${compact.error}`);
else if (!(compact.during?.mode === "window" && compact.during?.drawn && compact.during?.decorated === false && compact.during?.width < compact.before?.width && compact.during?.height < 200))
  problems.push(`the window did not turn compact: ${JSON.stringify(compact)}`);
else if (!(compact.after?.mode === "full" && compact.after?.decorated && backAtSize(compact.after, compact.before)))
  problems.push(`the window did not come back from compact: ${JSON.stringify(compact)}`);
if (shown(restored.restored)?.tracks !== audio.length) problems.push(`after a restart: ${JSON.stringify(restored.restored)}`);
if (problems.length > 0) {
  console.error(`desktop-check: ${problems.join("; ")}`);
  process.exit(1);
}
console.log("desktop-check: ok");
