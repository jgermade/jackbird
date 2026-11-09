#!/usr/bin/env node
// The family library's unattended check (F1): starts the built service with a
// home of its own (two songs in Music, one more elsewhere to upload) and a
// local SMTP sink, sets sign-in up through the console's key (email, an
// editor and a listener, the owner's address confirmed by its code), and
// drives Chromium (Playwright) as the three would. The owner imports Music
// from the machine; the editor uploads a song from their device and retitles
// one; the listener sees the new title, plays the song from the library, and
// downloads it carrying the title. The files on the machine are unchanged.
// Exits non-zero on the first thing missing.
//
//   node scripts/library-check.cjs target/release/jackbird-service
//
// See RECORD/2026-08-11.musikmatch-rust-migration.WIP.md (F1).

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright");

const binary = path.resolve(process.argv[2] ?? "target/release/jackbird-service");
const port = 4646 + Math.floor(Math.random() * 1000);
const smtpPort = port + 1000;
const home = fs.mkdtempSync(path.join(os.tmpdir(), "jackbird-library-check-"));
const music = path.join(home, "Music");
const elsewhere = path.join(home, "Elsewhere");
fs.mkdirSync(music);
fs.mkdirSync(elsewhere);
const fixtures = path.resolve("fixtures/tags");
for (const name of ["mp3-v24-padded.mp3", "flac-full.flac"]) fs.copyFileSync(path.join(fixtures, name), path.join(music, name));
fs.copyFileSync(path.join(fixtures, "mp3-v24-ape.mp3"), path.join(elsewhere, "ape.mp3"));
const config = path.join(home, "service.json");
const mailbox = path.join(home, "mail.jsonl");
const base = `http://localhost:${port}/`;
const pages = [];

const fail = (why) => {
  throw new Error(why);
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const env = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  XDG_DATA_HOME: path.join(home, "data"),
  LOCALAPPDATA: path.join(home, "data"),
  JACKBIRD_SERVICE_CONFIG: config
};

const start = () => spawn(binary, ["--port", String(port)], { env, stdio: ["ignore", "inherit", "inherit"] });

async function ready() {
  for (let step = 0; step < 100; step += 1) {
    try {
      if ((await fetch(`${base}api/info`)).ok) return;
    } catch {}
    await wait(100);
  }
  fail("the service did not start");
}

const mails = () =>
  fs.existsSync(mailbox) ? fs.readFileSync(mailbox, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];

async function codeFor(to, after) {
  for (let step = 0; step < 100; step += 1) {
    const found = mails().slice(after).reverse().find((mail) => mail.to.includes(to) && /^\d{6} /.test(mail.subject));
    if (found) return found.subject.slice(0, 6);
    await wait(100);
  }
  fail(`no code reached ${to}`);
}

/** The service, as an owner, through the console's key. */
async function console_(method, route, body) {
  const key = fs.readFileSync(path.join(home, "service.key"), "utf8");
  const response = await fetch(`${base}api/${route}`, {
    method,
    headers: { authorization: `Console ${key}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const answer = await response.json().catch(() => null);
  if (!response.ok) fail(`${route}: ${JSON.stringify(answer)}`);
  return answer;
}

async function person(browser, email) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  pages.push(page);
  page.on("pageerror", (error) => console.log("pageerror:", error.message));
  await page.goto(base);
  const sent = mails().length;
  await page.locator("#signin-email").fill(email);
  await page.getByRole("button", { name: "Send me a code" }).click();
  await page.locator("#signin-code").fill(await codeFor(email, sent));
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("dialog", { name: "Sign in" }).waitFor({ state: "hidden", timeout: 15000 });
  return page;
}

async function addMusic(page) {
  await page.getByRole("button", { name: "Add music" }).first().click();
  await page.getByRole("dialog", { name: "Add music" }).waitFor();
}

async function report(page) {
  const shown = page.getByText(/\d+ added, \d+ already there/);
  await shown.waitFor({ timeout: 60000 });
  return shown.innerText();
}

(async () => {
  const sink = spawn(process.execPath, [path.resolve("scripts/smtp-sink.mjs"), String(smtpPort), mailbox], { stdio: "inherit" });
  let service = start();
  const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
  try {
    await ready();
    // ── Sign-in, set up from the console.
    await console_("POST", "smtp", { host: "127.0.0.1", port: smtpPort, security: "none", from: "jackbird@example.com" });
    await console_("POST", "people", { name: "Luis", email: "editor@example.com", role: "editor" });
    await console_("POST", "people", { name: "Kids", email: "kids@example.com", role: "listener" });
    const owners = (await console_("GET", "people")).filter((one) => one.role === "owner");
    const sent = mails().length;
    const attempt = await console_("POST", "setup/email", { email: "owner@example.com", person: owners[0].id });
    await console_("POST", "setup/code", { attempt: attempt.attempt, code: await codeFor("owner@example.com", sent) });
    console.log("sign-in on, an editor and a listener invited");

    // ── The owner imports Music from the machine.
    const owner = await person(browser, "owner@example.com");
    await addMusic(owner);
    await owner.getByRole("button", { name: "Import a folder of this machine…" }).click();
    await owner.getByRole("button", { name: /^Music/ }).click();
    await owner.getByRole("button", { name: "Open this folder" }).click();
    const imported = await report(owner);
    console.log("owner imported Music:", imported);
    if (!/^2 added/.test(imported)) fail(`the import said ${imported}`);

    // ── The editor uploads a song and retitles one.
    const editor = await person(browser, "editor@example.com");
    await editor.getByText("Before").first().waitFor({ timeout: 30000 });
    await addMusic(editor);
    await editor.locator('input[type="file"][multiple]').setInputFiles(path.join(elsewhere, "ape.mp3"));
    const uploaded = await report(editor);
    console.log("editor uploaded a song:", uploaded);
    if (!/^1 added/.test(uploaded)) fail(`the upload said ${uploaded}`);
    await editor.getByRole("dialog", { name: "Add music" }).getByRole("button", { name: "Close" }).click();
    await editor.getByRole("button", { name: "More for Before" }).first().click();
    await editor.getByRole("menuitem", { name: "Edit tags…" }).first().click();
    await editor.getByLabel("Title", { exact: true }).fill("Retitled by Luis");
    await editor.screenshot({ path: path.join(home, "edit.png") });
    await editor.getByRole("button", { name: "Save changes" }).click();
    await editor.getByText("Retitled by Luis").first().waitFor({ timeout: 15000 });
    console.log("editor retitled a song");

    // ── The listener sees it, plays it, and downloads it with the title.
    const listener = await person(browser, "kids@example.com");
    await listener.getByText("Retitled by Luis").first().waitFor({ timeout: 30000 });
    const served = [];
    listener.on("response", (response) => {
      if (response.url().includes("/api/library/media?")) served.push(response.status());
    });
    await listener.getByText("Retitled by Luis", { exact: true }).first().click();
    await wait(1500);
    if (!served.some((status) => status === 200 || status === 206)) fail(`the song was not served: ${served}`);
    await listener.getByRole("button", { name: "More for Retitled by Luis" }).first().click();
    await listener.getByRole("menuitem", { name: "Info…" }).first().click();
    const link = listener.getByRole("link", { name: "Download" });
    await link.waitFor({ timeout: 15000 });
    const carried = await listener.evaluate(async (href) => {
      const bytes = new Uint8Array(await (await fetch(href)).arrayBuffer());
      const text = new TextDecoder("latin1").decode(bytes.slice(0, 65536));
      return [bytes.length, text.includes("Retitled by Luis") || new TextDecoder("utf-16le").decode(bytes.slice(0, 65536)).includes("Retitled by Luis")];
    }, await link.getAttribute("href"));
    console.log("listener played it (", served.join(" "), ") and downloaded", carried[0], "bytes carrying the title:", carried[1]);
    if (!carried[1]) fail("the download does not carry the family's title");

    // ── F3: the listener's own title; the editor still sees the family's.
    await listener.keyboard.press("Escape");
    await listener.getByRole("button", { name: "More for Retitled by Luis" }).first().click();
    await listener.getByRole("menuitem", { name: "Edit tags…" }).first().click();
    await listener.getByText("Saved for you only").waitFor();
    await listener.getByLabel("Title", { exact: true }).fill("The kids' title");
    await listener.screenshot({ path: path.join(home, "edit-own.png") });
    await listener.getByRole("button", { name: "Save changes" }).click();
    await listener.getByText("The kids' title").first().waitFor({ timeout: 15000 });
    await editor.reload();
    await editor.getByText("Retitled by Luis").first().waitFor({ timeout: 30000 });
    if ((await editor.getByText("The kids' title").count()) > 0) fail("the editor sees the listener's own title");
    console.log("listener titled the song for themselves; the editor still sees the family's");

    // Their favourite and their play, in their own playlists.
    await listener.getByRole("button", { name: "More for The kids' title" }).first().click();
    await listener.getByRole("menuitem", { name: "Add to favourites" }).click();
    await listener.getByText("The kids' title", { exact: true }).first().click();
    await wait(2500);
    const own = await listener.evaluate(async () => {
      const read = async (path) => (await fetch(`/api/library/read?path=${encodeURIComponent(path)}`)).text();
      return [await read("My playlists/Favourites.m3u"), await read("My playlists/Recently played.m3u")];
    });
    console.log("listener's favourites and plays:", JSON.stringify(own));
    if (!own[0].includes("flac-full.flac") && !own[0].includes(".mp3")) fail("no favourite");
    if (own[1].trim() === "#EXTM3U") fail("no play counted");
    const theirs = await editor.evaluate(async () => (await fetch("/api/library/read?path=My%20playlists%2FFavourites.m3u")).text());
    if (theirs.trim() !== "#EXTM3U") fail("the editor sees the listener's favourites");

    // The switch: the family's version.
    await listener.getByRole("button", { name: "Open preferences" }).first().click();
    await Promise.all([listener.waitForEvent("load"), listener.getByRole("switch", { name: "Your version" }).or(listener.getByLabel("Your version")).first().click()]);
    await listener.getByText("Retitled by Luis").first().waitFor({ timeout: 30000 });
    console.log("listener switched to the family's version");

    // ── The files on the machine were never written.
    for (const name of ["mp3-v24-padded.mp3", "flac-full.flac"]) {
      if (!fs.readFileSync(path.join(music, name)).equals(fs.readFileSync(path.join(fixtures, name)))) fail(`${name} was written`);
    }
    console.log("the files on the machine are as they were");

    // ── A restart: the library is as it was.
    service.kill();
    await new Promise((resolve) => service.on("exit", resolve));
    service = start();
    await ready();
    await listener.reload();
    await listener.getByText("Retitled by Luis").first().waitFor({ timeout: 30000 });
    await listener.screenshot({ path: path.join(home, "library.png") });
    console.log("library-check: ok", path.join(home, "library.png"));
  } catch (error) {
    for (const [at, open] of pages.entries()) {
      await open.screenshot({ path: path.join(home, `failed-${at}.png`) }).catch(() => undefined);
    }
    console.error("library-check: screenshots in", home);
    throw error;
  } finally {
    await browser.close();
    service.kill();
    sink.kill();
  }
})().catch((error) => {
  console.error("library-check:", error.message);
  process.exit(1);
});
