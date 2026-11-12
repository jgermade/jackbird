#!/usr/bin/env node
// The service's unattended check (S1-D6): starts the built service with a
// home of its own holding a copy of the fixtures (and any extra audio files
// given), drives its page in Chromium (Playwright) as a person would: opens
// the folder through the service's dialog, reads the tags, saves a title,
// plays an MP3 and a FLAC, then restarts the service, reloads the page and
// finds the folder again. Exits non-zero on the first thing missing.
//
//   node scripts/service-check.cjs target/release/jackbird-service [extra audio files…]
//
// Against a service already running (its container, F5): JACKBIRD_CHECK_URL is its address,
// JACKBIRD_CHECK_MUSIC the folder it shows as Music (filled here), and JACKBIRD_CHECK_RESTART the
// shell command that restarts it (`docker compose restart jackbird`).
//
// Needs Playwright with its Chromium (`npm i --no-save playwright` and
// `npx playwright install chromium` where it is not installed). See
// RECORD/2026-08-11.musikmatch-rust-migration.WIP.md (S1).

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright");

const binary = path.resolve(process.argv[2] ?? "target/release/jackbird-service");
const extra = process.argv.slice(3);
const port = 4646 + Math.floor(Math.random() * 1000);
const home = fs.mkdtempSync(path.join(os.tmpdir(), "jackbird-service-check-"));
const external = process.env.JACKBIRD_CHECK_URL;
const music = process.env.JACKBIRD_CHECK_MUSIC ?? path.join(home, "Music");
fs.mkdirSync(music, { recursive: true });
const fixtures = path.resolve("fixtures/tags");
for (const name of fs.readdirSync(fixtures).filter((name) => /\.(mp3|flac)$/i.test(name))) {
  fs.copyFileSync(path.join(fixtures, name), path.join(music, name));
}
for (const file of extra) fs.copyFileSync(file, path.join(music, path.basename(file)));
const config = path.join(home, "service.json");
const base = external ? external.replace(/\/?$/, "/") : `http://localhost:${port}/`;

/** A service already running: started and stopped by JACKBIRD_CHECK_RESTART. */
const outside = { kill: () => undefined, on: (_event, done) => done() };

function start() {
  if (external) return outside;
  const service = spawn(binary, ["--port", String(port)], {
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      // The family library (F1) in this home too, not the machine's own data folder.
      XDG_DATA_HOME: path.join(home, "data"),
      LOCALAPPDATA: path.join(home, "data"),
      JACKBIRD_SERVICE_CONFIG: config
    },
    stdio: ["ignore", "inherit", "inherit"]
  });
  return service;
}

async function ready() {
  for (let step = 0; step < 100; step += 1) {
    try {
      if ((await fetch(`${base}api/info`)).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("the service did not start");
}

const fail = (why) => {
  throw new Error(why);
};

(async () => {
  let service = start();
  const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
  try {
    await ready();
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on("pageerror", (error) => console.log("pageerror:", error.message));
    await page.goto(base);

    // Open the folder through the service's dialog: home, then Music.
    await page.getByRole("button", { name: /^(Open library|Add a folder|Add to the library|Choose a folder( of .+)?…)$/ }).first().click();
    await page.getByRole("button", { name: /^Music/ }).click();
    await page.getByRole("button", { name: "Open this folder" }).click();
    await page.getByText("Before").first().waitFor({ timeout: 30000 });
    // The open root's tab counts its tracks ("12/26" while their tags load, then "26").
    const counted = await page.waitForFunction(() => {
      const meta = document.querySelector('[role="tab"][aria-selected="true"] .meta')?.textContent?.trim() ?? "";
      return /^\d+$/.test(meta) ? meta : null;
    }, null, { timeout: 30000 });
    const tracks = await counted.jsonValue();
    console.log("opened: the library shows", tracks, "tracks");
    if (!(Number(tracks) >= 26)) fail(`the library shows ${tracks} tracks`);

    // Save a title through the edit dialog.
    await page.getByRole("button", { name: "More for Before" }).first().click();
    await page.getByRole("menuitem", { name: "Edit tags…" }).or(page.getByRole("button", { name: "Edit tags…" })).first().click();
    await page.getByLabel("Title", { exact: true }).fill("Saved through the service");
    await page.getByRole("button", { name: "Save changes" }).click();
    await page.getByText(/Metadata saved to|Could not save/).first().waitFor({ timeout: 15000 });
    const message = (await page.locator("body").innerText()).match(/Metadata saved to[^\n]*|Could not save[^\n]*/)?.[0];
    await page.getByText("Saved through the service").first().waitFor({ timeout: 15000 });
    console.log("saved:", message);
    if (!/^Metadata saved/.test(message ?? "")) fail(`the save said ${message}`);

    // Play an MP3 and a FLAC: the service serves their bytes (200 or 206, with ranges), and a long
    // one's time moves on the display.
    const served = [];
    page.on("response", (response) => {
      if (response.url().includes("/api/media?")) served.push(response.status());
    });
    for (const title of ["Before", "Totals"]) {
      const before = served.length;
      await page.getByText(title, { exact: true }).first().click();
      await page.waitForTimeout(1500);
      if (!served.slice(before).some((status) => status === 200 || status === 206)) fail(`${title} was not served: ${served.slice(before)}`);
    }
    const long = extra.length > 0 ? "Blue Tone" : null;
    if (long) {
      await page.getByText(long, { exact: true }).first().click();
      await page.waitForTimeout(3500);
      const shown = await page.evaluate(() => document.body.innerText.toUpperCase());
      const meters = await page.evaluate(() =>
        [...document.querySelectorAll("[aria-valuenow]")].map((meter) => `${meter.getAttribute("aria-label")}=${meter.getAttribute("aria-valuenow")} (${meter.getAttribute("aria-valuetext")})`)
      );
      const seconds = Math.max(0, ...meters.map((text) => Number(text.match(/=([\d.]+)/)?.[1] ?? 0)));
      console.log(`playing ${long}: ${meters.join("; ")}`);
      // Headless and with no sound card, the audio clock runs slow: moving on is what counts.
      if (!shown.includes(long.toUpperCase()) || !(seconds > 0.5)) fail(`${long} did not play`);
    }
    console.log("media served:", served.join(" "));

    // Restart the service; reload: the session reopens the folder through it.
    service.kill();
    await new Promise((resolve) => service.on("exit", resolve));
    if (external && process.env.JACKBIRD_CHECK_RESTART) {
      require("node:child_process").execSync(process.env.JACKBIRD_CHECK_RESTART, { stdio: "inherit" });
    }
    service = start();
    await ready();
    await page.reload();
    await page.getByText("Saved through the service").first().waitFor({ timeout: 30000 });
    console.log("after a restart: the folder is back, with the saved title");
    await page.screenshot({ path: path.join(home, "service.png") });
    console.log("service-check: ok", path.join(home, "service.png"));
  } finally {
    await browser.close();
    service.kill();
  }
})().catch((error) => {
  console.error("service-check:", error.message);
  process.exit(1);
});
