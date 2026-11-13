#!/usr/bin/env node
// Sign-in and people's unattended check (S3): starts the built service with a
// home of its own (a copy of the fixtures in Music) and a local SMTP sink
// (scripts/smtp-sink.mjs), and drives its page in Chromium (Playwright) as
// the people would. The owner, at the machine, opens the folder, sets up
// email, adds an editor and a listener, and turns sign-in on with the code
// sent to their address; the two are invited. The editor signs in with the
// code, adds a passkey (Chromium's virtual authenticator), signs out, signs
// in with the passkey, and saves a title. The listener signs in and is not
// offered editing, and the service refuses it when tried by hand. The
// owner's log shows the editor's save. The service is restarted and the
// editor is still in, with the folder. Exits non-zero on the first thing
// missing.
//
//   node scripts/signin-check.cjs target/release/jackbird-service
//
// See RECORD/2026-08-11.musikmatch-rust-migration.WIP.md (S3).

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright");

const binary = path.resolve(process.argv[2] ?? "target/release/jackbird-service");
const { freePort } = require("./free-port.cjs");
// Free on both loopbacks (scripts/free-port.cjs), not picked at random.
const port = freePort();
const smtpPort = freePort();
const home = fs.mkdtempSync(path.join(os.tmpdir(), "jackbird-signin-check-"));
const music = path.join(home, "Music");
fs.mkdirSync(music);
const fixtures = path.resolve("fixtures/tags");
for (const name of fs.readdirSync(fixtures).filter((name) => /\.(mp3|flac)$/i.test(name))) {
  fs.copyFileSync(path.join(fixtures, name), path.join(music, name));
}
const config = path.join(home, "service.json");
const mailbox = path.join(home, "mail.jsonl");
const base = `http://localhost:${port}/`;

const fail = (why) => {
  throw new Error(why);
};
/** The pages open, for a screenshot of each when something is missing. */
const pages = [];
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function start() {
  return spawn(binary, ["--port", String(port)], {
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
}

async function ready() {
  for (let step = 0; step < 100; step += 1) {
    try {
      if ((await fetch(`${base}api/info`)).ok) return;
    } catch {}
    await wait(100);
  }
  fail("the service did not start");
}

/** The emails sent so far. */
const mails = () =>
  fs.existsSync(mailbox)
    ? fs.readFileSync(mailbox, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line))
    : [];

/** The code of the newest email to `to`, waiting for it. */
async function codeFor(to, after) {
  for (let step = 0; step < 300; step += 1) {
    const found = mails().slice(after).reverse().find((mail) => mail.to.includes(to) && /^\d{6} /.test(mail.subject));
    if (found) return found.subject.slice(0, 6);
    await wait(100);
  }
  fail(`no code reached ${to}`);
}

async function signInByCode(page, email) {
  const sent = mails().length;
  await page.locator("#signin-email").fill(email);
  await page.screenshot({ path: path.join(home, "signin-dialog.png") });
  await page.getByRole("button", { name: "Send me a code" }).click();
  await page.locator("#signin-code").fill(await codeFor(email, sent));
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("dialog", { name: "Sign in" }).waitFor({ state: "hidden", timeout: 15000 });
}

/** Opens the preferences at their Account section (people and sign-in, passkeys, signing out). */
async function openPreferences(page) {
  await page.getByRole("button", { name: "Open preferences" }).first().click();
  await page.getByRole("tab", { name: "Account", exact: true }).click();
}

(async () => {
  const sink = spawn(process.execPath, [path.resolve("scripts/smtp-sink.mjs"), String(smtpPort), mailbox], { stdio: "inherit" });
  let service = start();
  const browser = await chromium.launch();
  try {
    await ready();
    // ── The owner, at the machine: open, no sign-in.
    const owner = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await owner.newPage();
    pages.push(page);
    page.on("pageerror", (error) => console.log("pageerror:", error.message));
    await page.goto(base);
    await page.getByRole("button", { name: /^(Open library|Add a folder|Add to the library|Choose a folder( of .+)?…)$/ }).first().click();
    await page.getByRole("button", { name: /^Music/ }).click();
    await page.getByRole("button", { name: "Open this folder" }).click();
    await page.getByText("Before").first().waitFor({ timeout: 30000 });
    console.log("owner: the folder is open");

    await openPreferences(page);
    await page.getByRole("button", { name: "People and sign-in…" }).click();
    await page.getByRole("tab", { name: "Sign-in" }).click();
    await page.locator("#smtp-host").fill("127.0.0.1");
    await page.locator("#smtp-security").selectOption("none");
    await page.locator("#smtp-port").fill(String(smtpPort));
    await page.locator("#smtp-from").fill("jackbird@example.com");
    await page.getByRole("button", { name: "Save email settings" }).click();
    await page.getByText("Email settings saved.").waitFor();
    await page.screenshot({ path: path.join(home, "people-signin.png") });
    console.log("owner: email set up");

    await page.getByRole("tab", { name: "People" }).click();
    for (const [name, email, role] of [["Luis", "editor@example.com", "editor"], ["Kids", "kids@example.com", "listener"]]) {
      await page.getByRole("button", { name: "Add someone" }).click();
      await page.locator("#person-name").fill(name);
      await page.locator("#person-email").fill(email);
      await page.locator("#person-role").selectOption(role);
      await page.getByRole("button", { name: "Add", exact: true }).click();
      await page.getByRole("button", { name: new RegExp(`^${name}`) }).waitFor();
    }
    console.log("owner: an editor and a listener added, as profiles");
    await page.screenshot({ path: path.join(home, "people.png") });

    await page.getByRole("tab", { name: "Sign-in" }).click();
    const before = mails().length;
    await page.locator("#setup-email").fill("owner@example.com");
    await page.getByRole("button", { name: "Send the code" }).click();
    await page.locator("#setup-code").fill(await codeFor("owner@example.com", before));
    await Promise.all([page.waitForEvent("load"), page.getByRole("button", { name: "Turn sign-in on" }).click()]);
    await page.getByText("Before").first().waitFor({ timeout: 30000 });
    const invited = mails().filter((mail) => /invited/.test(mail.subject)).flatMap((mail) => mail.to);
    console.log("owner: sign-in is on, still in; invitations to", invited.join(", "));
    if (!invited.includes("editor@example.com") || !invited.includes("kids@example.com")) fail("the invitations were not sent");

    // ── The editor, in another browser: a code, a passkey, a save.
    const editor = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const editing = await editor.newPage();
    pages.push(editing);
    editing.on("pageerror", (error) => console.log("pageerror:", error.message));
    const cdp = await editor.newCDPSession(editing);
    await cdp.send("WebAuthn.enable");
    await cdp.send("WebAuthn.addVirtualAuthenticator", {
      options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true }
    });
    await editing.goto(base);
    await signInByCode(editing, "editor@example.com");
    await editing.getByText("Before").first().waitFor({ timeout: 30000 });
    console.log("editor: signed in with the code, and sees the owner's folder");

    await openPreferences(editing);
    await editing.locator("#passkey-name").fill("Laptop");
    await editing.getByRole("button", { name: "Add a passkey on this device" }).click();
    await editing.getByText("Laptop").waitFor({ timeout: 15000 });
    await editing.waitForTimeout(500);
    await editing.screenshot({ path: path.join(home, "account.png") });
    await Promise.all([editing.waitForEvent("load"), editing.getByRole("button", { name: "Sign out", exact: true }).click()]);
    await editing.getByRole("button", { name: "Sign in with a passkey" }).click();
    await editing.getByText("Before").first().waitFor({ timeout: 30000 });
    console.log("editor: a passkey added, signed out, and back in with it");

    await editing.getByRole("button", { name: "More for Before" }).first().click();
    await editing.getByRole("menuitem", { name: "Edit tags…" }).or(editing.getByRole("button", { name: "Edit tags…" })).first().click();
    await editing.getByLabel("Title", { exact: true }).fill("Saved by the editor");
    await editing.getByRole("button", { name: "Save changes" }).click();
    await editing.getByText("Saved by the editor").first().waitFor({ timeout: 15000 });
    console.log("editor: a title saved");

    // ── The listener: no editing offered, and the service refuses it by hand.
    const listener = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const listening = await listener.newPage();
    pages.push(listening);
    await listening.goto(base);
    await signInByCode(listening, "kids@example.com");
    await listening.getByText("Saved by the editor").first().waitFor({ timeout: 30000 });
    await listening.getByRole("button", { name: "More for Saved by the editor" }).first().click();
    const offered = await listening.getByRole("menuitem", { name: "Edit tags…" }).count();
    await listening.keyboard.press("Escape");
    const refused = await listening.evaluate(async () => {
      const save = await fetch("/api/mkdir?root=x&path=y", { method: "POST" });
      const folders = await fetch("/api/folders");
      return [save.status, folders.status];
    });
    console.log("listener: editing offered", offered, "times; the service answers", refused.join(" and "));
    if (offered !== 0 || refused[0] !== 403 || refused[1] !== 403) fail("the listener could edit");

    // ── The owner's log.
    await openPreferences(page);
    await page.getByRole("button", { name: "People and sign-in…" }).click();
    await page.getByRole("tab", { name: "Changes" }).click();
    await page.getByText(/Luis edited the tags of/).first().waitFor({ timeout: 15000 });
    console.log("owner: the log shows Luis's save");

    // ── A restart: sessions are kept.
    service.kill();
    await new Promise((resolve) => service.on("exit", resolve));
    service = start();
    await ready();
    await editing.reload();
    await editing.getByText("Saved by the editor").first().waitFor({ timeout: 30000 });
    if (await editing.getByRole("dialog", { name: "Sign in" }).isVisible()) fail("the editor was signed out by the restart");
    console.log("after a restart: the editor is still in, with the folder");
    await editing.screenshot({ path: path.join(home, "signin.png") });
    console.log("signin-check: ok", path.join(home, "signin.png"));
  } catch (error) {
    for (const [at, open] of pages.entries()) {
      const shown = await open.locator(".failure").allInnerTexts().catch(() => []);
      if (shown.length > 0) console.error(`signin-check: page ${at} says:`, shown.join(" | "));
      await open.screenshot({ path: path.join(home, `failed-${at}.png`) }).catch(() => undefined);
    }
    console.error("signin-check: screenshots in", home);
    throw error;
  } finally {
    await browser.close();
    service.kill();
    sink.kill();
  }
})().catch((error) => {
  console.error("signin-check:", error.message);
  process.exit(1);
});
