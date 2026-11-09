#!/usr/bin/env node
// A phone's unattended check (E6's spike): starts jackbird's service on this machine (open, its
// owner the only person), a receiver for the report, puts the audio fixtures in the folder the
// build was made for, and starts the app built with VITE_JACKBIRD_PHONE_CHECK
// (src/lib/phone-check.ts) in Android's emulator or iOS's simulator; then checks its report:
// connected as the owner, the folder's tracks listed, a FLAC played. Run by mobile.yml:
//
//   node scripts/phone-check.mjs android path/to/app.apk
//   node scripts/phone-check.mjs ios path/to/jackbird.app
//
// The phone reaches the service at localhost:4646 and the receiver at localhost:4700: on Android
// through `adb reverse`, on iOS's simulator directly (it shares the machine's network).
// PHONE_MUSIC is the folder the build names. See RECORD/2026-08-11.musikmatch-rust-migration.WIP.md (E6).

import { execFileSync, spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const [platform, app] = process.argv.slice(2);
const music = process.env.PHONE_MUSIC;
const service = resolve(process.env.JACKBIRD_SERVICE ?? "target/release/jackbird-service");
if (!["android", "ios"].includes(platform) || !app || !music) {
  console.error("usage: PHONE_MUSIC=<folder> node scripts/phone-check.mjs android|ios <app>");
  process.exit(2);
}
const run = (program, args) => execFileSync(program, args, { stdio: "inherit" });
const read = (program, args) => execFileSync(program, args, { encoding: "utf8" });

mkdirSync(music, { recursive: true });
for (const name of readdirSync("fixtures/audio").filter((name) => /\.(flac|mp3)$/.test(name))) {
  cpSync(join("fixtures/audio", name), join(music, name));
}

const home = mkdtempSync(join(tmpdir(), "jackbird-phone-"));
const server = spawn(service, ["--port", "4646"], {
  env: { ...process.env, HOME: home, XDG_DATA_HOME: join(home, "data"), JACKBIRD_SERVICE_CONFIG: join(home, "service.json") },
  stdio: ["ignore", "inherit", "inherit"]
});
for (let step = 0; step < 50; step += 1) {
  if (await fetch("http://127.0.0.1:4646/api/info").then((response) => response.ok, () => false)) break;
  await new Promise((done) => setTimeout(done, 200));
}

const reported = new Promise((done) => {
  createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      response.writeHead(204, { "access-control-allow-origin": "*" }).end();
      if (request.method === "POST") done(JSON.parse(body));
    });
  }).listen(4700);
});

const bundle = "es.germade.jackbird";
if (platform === "android") {
  run("adb", ["reverse", "tcp:4646", "tcp:4646"]);
  run("adb", ["reverse", "tcp:4700", "tcp:4700"]);
  run("adb", ["install", "-r", app]);
  run("adb", ["shell", "monkey", "-p", bundle, "-c", "android.intent.category.LAUNCHER", "1"]);
} else {
  const devices = JSON.parse(read("xcrun", ["simctl", "list", "devices", "available", "-j"])).devices;
  const phone = Object.entries(devices)
    .filter(([runtime]) => runtime.includes("iOS"))
    .flatMap(([, list]) => list)
    .find((device) => /iPhone/.test(device.name));
  if (!phone) throw new Error("no iPhone simulator");
  console.log(`phone-check: ${phone.name}`);
  if (phone.state !== "Booted") run("xcrun", ["simctl", "boot", phone.udid]);
  run("xcrun", ["simctl", "install", phone.udid, app]);
  run("xcrun", ["simctl", "launch", phone.udid, bundle]);
}

const report = await Promise.race([reported, new Promise((done) => setTimeout(() => done(null), 240_000))]);
server.kill();
if (!report) {
  if (platform === "android") {
    try {
      console.log(read("adb", ["logcat", "-d", "-t", "400"]).split("\n").filter((line) => /jackbird|Tauri|chromium|Console/i.test(line)).join("\n"));
    } catch {
      // No log to show.
    }
  }
  console.error("phone-check: no report in 4 minutes");
  process.exit(1);
}
console.log(JSON.stringify(report, null, 2));
const problems = [];
if (report.error) problems.push(`error: ${report.error}`);
if (report.me?.role !== "owner") problems.push(`not in as the owner: ${JSON.stringify(report.me)}`);
if (!(report.tracks >= 3)) problems.push(`tracks: ${report.tracks}`);
if (!report.played || report.played.error || !(report.played.played > 0)) problems.push(`the FLAC did not play: ${JSON.stringify(report.played)}`);
if (problems.length > 0) {
  console.error(`phone-check: ${problems.join("; ")}`);
  process.exit(1);
}
console.log("phone-check: ok");
process.exit(0);
