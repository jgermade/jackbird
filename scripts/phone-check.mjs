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
// iOS's simulator shares this machine's network: it reaches the service at localhost:4646 and the
// receiver at localhost:4700. Android's emulator reaches them at 10.0.2.2 (4647, a proxy, and 4700).
// PHONE_MUSIC is the folder the build names. See RECORD/2026-08-11.musikmatch-rust-migration.WIP.md (E6).

import { execFileSync, spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync } from "node:fs";
import { createServer, request as forward } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const [platform, app] = process.argv.slice(2);
const music = process.env.PHONE_MUSIC;
const service = resolve(process.env.JACKBIRD_SERVICE ?? "target/release/jackbird-service");
if (!["android", "ios"].includes(platform) || !app || !music) {
  console.error("usage: PHONE_MUSIC=<folder> node scripts/phone-check.mjs android|ios <app>");
  process.exit(2);
}
// Every command has five minutes (a simulator's first launch after booting is slow): a phone that
// does not answer fails the check, never hangs it.
const run = (program, args) => {
  console.log(`phone-check: ${program} ${args.join(" ")}`);
  execFileSync(program, args, { stdio: "inherit", timeout: 300_000 });
};
/** Once more if it fails the first time (a launch the system was not ready for). */
const runTwice = (program, args) => {
  try {
    run(program, args);
  } catch (error) {
    console.log(`phone-check: ${program} ${args.join(" ")} failed (${error.message}); once more`);
    run(program, args);
  }
};
const read = (program, args) => execFileSync(program, args, { encoding: "utf8", timeout: 120_000 });

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

// The reports by phase: the check's ("report"), then the background measurement's ("playing",
// "background").
const waiting = {};
const phases = {};
const phase = (name) => (phases[name] ??= new Promise((done) => (waiting[name] = done)));
createServer((request, response) => {
  let body = "";
  request.on("data", (chunk) => (body += chunk));
  request.on("end", () => {
    response.writeHead(204, { "access-control-allow-origin": "*" }).end();
    console.log(`phone-check: <- ${request.method} ${request.url} ${body.slice(0, 400)}`);
    if (request.method !== "POST") return;
    const name = new URL(request.url, "http://localhost").searchParams.get("phase") ?? "report";
    if (name === "step" && platform === "android" && JSON.parse(body || "{}").step === "picking") void grantFolder();
    phase(name);
    waiting[name](JSON.parse(body || "{}"));
  });
}).listen(4700);
const reported = phase("report");

// Android's folder picker, as a person goes through it (E6b-D9): it opens at the folder the build
// names; "Use this folder", then "Allow". Its screen is read with uiautomator, and each key tapped
// at its middle. Tries for a minute.
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
async function tapText(pattern) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      execFileSync("adb", ["shell", "uiautomator", "dump", "/sdcard/ui.xml"], { timeout: 30_000 });
      const xml = execFileSync("adb", ["shell", "cat", "/sdcard/ui.xml"], { encoding: "utf8", timeout: 30_000 });
      for (const node of xml.match(/<node [^>]*>/g) ?? []) {
        const text = /text="([^"]*)"/.exec(node)?.[1] ?? "";
        const bounds = /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(node);
        if (bounds && pattern.test(text)) {
          const [x, y] = [(+bounds[1] + +bounds[3]) >> 1, (+bounds[2] + +bounds[4]) >> 1];
          console.log(`phone-check: picker: tapping "${text}" at ${x},${y}`);
          execFileSync("adb", ["shell", "input", "tap", String(x), String(y)], { timeout: 30_000 });
          return true;
        }
      }
    } catch (error) {
      console.log(`phone-check: picker: ${error.message}`);
    }
    await sleep(3000);
  }
  console.log(`phone-check: picker: no ${pattern} on the screen`);
  return false;
}
async function grantFolder() {
  await sleep(3000);
  if (await tapText(/^use this folder$/i)) await tapText(/^allow$/i);
}
const within = (promise, ms) => Promise.race([promise, new Promise((done) => setTimeout(() => done(null), ms))]);

// Android's emulator reaches this machine at 10.0.2.2 (not through `adb reverse`, which did not keep
// the emulator alive through the app's first requests): the service there through a proxy that asks it
// by its own name (an open instance answers only to it), the receiver directly.
if (platform === "android") {
  createServer((incoming, outgoing) => {
    // Each request is logged with its answer and how long it took (E6's queue in the background: does
    // the page's request reach the service?).
    const asked = Date.now();
    const what = `${incoming.method} ${incoming.url.replace(/([?&]t=)[^&]+/, "$1…")}`;
    console.log(`phone-check: proxy <- ${what}`);
    const upstream = forward(
      { host: "127.0.0.1", port: 4646, method: incoming.method, path: incoming.url, headers: { ...incoming.headers, host: "localhost:4646" } },
      (answer) => {
        console.log(`phone-check: proxy -> ${what} ${answer.statusCode} in ${Date.now() - asked} ms`);
        outgoing.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(outgoing);
      }
    );
    upstream.on("error", (error) => {
      console.log(`phone-check: proxy -> ${what} failed: ${error.message}`);
      outgoing.writeHead(502).end();
    });
    incoming.pipe(upstream);
  }).listen(4647);
}

const bundle = "es.germade.jackbird";
// The phone's own log, kept from the start, shown when the check fails: the page's console is there
// (Android: Tauri/Console in logcat; iOS: the app's process in the simulator's log).
const logPath = join(home, "phone.log");
const logFile = openSync(logPath, "w");
let logger = null;
const startLog = () => {
  logger =
    platform === "android"
      ? spawn("adb", ["logcat", "-v", "brief"], { stdio: ["ignore", logFile, logFile] })
      : spawn("xcrun", ["simctl", "spawn", "booted", "log", "stream", "--style", "compact", "--predicate", 'process == "jackbird"'], {
          stdio: ["ignore", logFile, logFile]
        });
};
const shot = join(process.env.PHONE_SHOTS ?? home, `${platform}.png`);
const screenshot = () => {
  try {
    if (platform === "android") {
      execFileSync("adb", ["shell", "screencap", "-p", "/sdcard/jackbird.png"], { timeout: 30_000 });
      execFileSync("adb", ["pull", "/sdcard/jackbird.png", shot], { timeout: 30_000 });
    }
    else execFileSync("xcrun", ["simctl", "io", "booted", "screenshot", shot], { timeout: 30_000 });
    console.log(`phone-check: screenshot at ${shot}`);
  } catch (error) {
    console.log(`phone-check: no screenshot (${error})`);
  }
};
const showLog = () => {
  screenshot();
  logger?.kill();
  const lines = readFileSync(logPath, "utf8").split("\n");
  const wanted = lines.filter((line) => /jackbird|Tauri|chromium|Console|WebView|FATAL|AndroidRuntime|JACKBIRD/i.test(line));
  console.log(`phone-check: the phone's log (${wanted.length} of ${lines.length} lines):`);
  console.log(wanted.slice(-300).join("\n"));
};
if (platform === "android") {
  startLog();
  run("adb", ["install", "-r", app]);
  // A folder of the phone (E6b-D9): the audio fixtures and a tagged FLAC, in its shared storage, for
  // Android's folder picker to grant (driven below, when the page says it is picking).
  run("adb", ["shell", "mkdir", "-p", "/sdcard/Music/jackbird-check"]);
  for (const name of readdirSync(music)) run("adb", ["push", join(music, name), `/sdcard/Music/jackbird-check/${name}`]);
  run("adb", ["push", "fixtures/tags/flac-full.flac", "/sdcard/Music/jackbird-check/flac-full.flac"]);
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
  // Booted is not ready: wait for the system to have started.
  run("xcrun", ["simctl", "bootstatus", phone.udid, "-b"]);
  startLog();
  run("xcrun", ["simctl", "install", phone.udid, app]);
  runTwice("xcrun", ["simctl", "launch", phone.udid, bundle]);
}

const report = await within(reported, 240_000);
if (!report) {
  showLog();
  console.error("phone-check: no report in 4 minutes");
  server.kill();
  process.exit(1);
}

// Background playback, measured (required on Android, through the native player, E6b-D7; measured
// only on iOS until its player, E6b's step 2): once the queue of silences plays (with sound), the app goes
// to the background (the home screen; on iOS, Settings in front of it, which can take the simulator
// most of a minute); two minutes after the page says it is hidden, the app comes back. Meanwhile, on
// Android, what the system says of the app: its process's state (a frozen app plays nothing) and
// whether it has a media session (the notification's and the lock screen's controls).
// Whether a media session of the app's was seen playing (PlaybackState 3) while it was away: the
// native player's (E6b), whose notification and lock screen's controls come from it.
let sessionPlaying = false;
const androidSays = (when) => {
  for (const [what, args] of [
    ["the process", ["shell", "dumpsys", "activity", "processes", bundle]],
    ["the media sessions", ["shell", "dumpsys", "media_session"]]
  ]) {
    try {
      const text = read("adb", args);
      if (what === "the media sessions" && text.includes(bundle) && /state=PlaybackState \{state=(3|PLAYING)\b/.test(text)) sessionPlaying = true;
      const lines = text.split("\n");
      const wanted = lines.filter((line) => line.includes(bundle) || /procState|frozen|state=|active=|Sessions Stack/i.test(line));
      console.log(`phone-check: ${when}, ${what}:\n${wanted.slice(0, 25).join("\n")}`);
    } catch (error) {
      console.log(`phone-check: ${when}, ${what}: ${error.message}`);
    }
  }
};
let background = null;
if (await within(phase("playing"), 60_000)) {
  // Past the first change of song (20 s), to see one in the foreground too.
  await new Promise((done) => setTimeout(done, 25_000));
  if (platform === "android") run("adb", ["shell", "input", "keyevent", "KEYCODE_HOME"]);
  else run("xcrun", ["simctl", "launch", "booted", "com.apple.Preferences"]);
  if (await within(phase("hidden"), 90_000)) {
    for (let step = 1; step <= 4; step += 1) {
      await new Promise((done) => setTimeout(done, 30_000));
      if (platform === "android") androidSays(`${step * 30} s away`);
    }
  } else console.log("phone-check: the page never said it was hidden");
  if (platform === "android") run("adb", ["shell", "monkey", "-p", bundle, "-c", "android.intent.category.LAUNCHER", "1"]);
  else run("xcrun", ["simctl", "launch", "booted", bundle]);
  background = await within(phase("background"), 120_000);
}
server.kill();
if (background?.samples) {
  // From the last sample shown before the page was hidden to the first shown after it: how long it
  // was away, and how much played meanwhile (the page's timers may be held back while hidden).
  const samples = background.samples;
  const first = samples.findIndex((sample) => sample.hidden);
  const back = first < 0 ? -1 : samples.findIndex((sample, index) => index > first && !sample.hidden);
  const before = samples[Math.max(first - 1, 0)];
  const after = back < 0 ? samples[samples.length - 1] : samples[back];
  const away = first < 0 ? 0 : (after.at - before.at) / 1000;
  const played = first < 0 ? 0 : after.played - before.played;
  // The queue's changes of song made while the page was hidden, and how many of them started (each
  // with its steps: the next URL's arrival, play() settling).
  const changes = background.changes ?? [];
  const hiddenChanges = changes.filter((change) => change.hidden);
  for (const change of changes) console.log(`phone-check: change of song ${JSON.stringify(change)}`);
  report.background = {
    native: Boolean(background.native),
    sessionPlaying,
    ended: background.ended ?? null,
    failures: background.failures ?? [],
    muted: background.muted,
    changesWhileHidden: hiddenChanges.length,
    startedWhileHidden: hiddenChanges.filter((change) => change.started).length,
    changes,
    mediaSession: background.mediaSession,
    hiddenSamples: samples.filter((sample) => sample.hidden).length,
    awaySeconds: Math.round(away * 10) / 10,
    playedWhileAway: Math.round(played * 10) / 10,
    samples
  };
  console.log(
    `phone-check: ${background.muted ? "muted" : "with sound"}, navigator.mediaSession ${background.mediaSession ? "present" : "absent"}, away ${away.toFixed(1)} s, played ${played.toFixed(1)} s meanwhile; ` +
      `${hiddenChanges.filter((change) => change.started).length} of ${hiddenChanges.length} changes of song made while hidden started`
  );
} else {
  report.background = null;
  console.log("phone-check: no background measurement");
}
console.log(JSON.stringify(report, null, 2));
const problems = [];
if (report.error) problems.push(`error: ${report.error}`);
if (report.me?.role !== "owner") problems.push(`not in as the owner: ${JSON.stringify(report.me)}`);
if (!(report.tracks >= 3)) problems.push(`tracks: ${report.tracks}`);
if (!report.played || report.played.error || !(report.played.played > 0)) problems.push(`the FLAC did not play: ${JSON.stringify(report.played)}`);
// The native player (E6b-D7, Android for now): the queue goes on in the background by itself.
if (platform === "android") {
  const background = report.background;
  // A folder of the phone (E6b-D9): granted in Android's picker, walked, the tagged FLAC's title read by
  // Rust through the file Android opened, and a FLAC played from its content:// address.
  const device = report.device;
  if (!device?.picked || !(device.tracks >= 4) || device.title !== "Before" || !(device.played > 0) || device.failures?.length) {
    problems.push(`the phone's folder: ${JSON.stringify(device ?? null)}`);
  }
  if (!background?.native) problems.push("the native player's queue was not measured");
  else {
    if (background.changesWhileHidden < 2) problems.push(`${background.changesWhileHidden} changes of song while hidden (2 or more expected)`);
    if (background.failures.length > 0) problems.push(`the native player failed: ${JSON.stringify(background.failures)}`);
    if (!background.sessionPlaying) problems.push("no media session of the app's seen playing while it was away");
  }
}
if (problems.length > 0) {
  showLog();
  console.error(`phone-check: ${problems.join("; ")}`);
  process.exit(1);
}
screenshot();
logger?.kill();
console.log("phone-check: ok");
process.exit(0);
