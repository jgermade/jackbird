#!/usr/bin/env node
// Checks landing/setup.sh, the service's one-line setup, without installing anything: it is run
// with a stand-in for the release's binary (a script that records the commands it is given and
// keeps a registration and a copy of itself where the real one would, under a temporary home and
// a temporary root), and what it then says and does is compared with what is expected.
//
//   node scripts/setup-check.mjs
//
// Linux and macOS (the script's own systems). The questions it asks on a terminal are not
// checked here: there is none. See RECORD/2026-11-12.landing-page.WIP.md.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The script is for Linux and macOS: there is nothing of it to check on Windows.
if (process.platform === "win32") {
  console.log("setup.sh: not checked on Windows");
  process.exit(0);
}

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(repo, "landing/setup.sh");
const work = mkdtempSync(join(tmpdir(), "jackbird-setup-check-"));
const home = join(work, "home");
const root = join(work, "root");
const log = join(work, "commands.log");
const tools = join(work, "tools");
mkdirSync(home, { recursive: true });
mkdirSync(root, { recursive: true });
mkdirSync(tools, { recursive: true });

// sudo, for the check: it says it was asked and runs the command as it is.
writeFileSync(join(tools, "sudo"), `#!/bin/sh\necho "sudo" >> "${log}"\nexec "$@"\n`);
chmodSync(join(tools, "sudo"), 0o755);

/** A stand-in for jackbird-service at `version`: the registrations and the binary's places are install.rs's. */
function standIn(version) {
  const path = join(work, `jackbird-service-${version}`);
  writeFileSync(
    path,
    `#!/bin/sh
VERSION="${version}"
LOG="${log}"
ROOT="${root}"
case "$(uname -s)" in
  Darwin)
    logon_unit="$HOME/Library/LaunchAgents/es.germade.jackbird.service.plist"
    logon_bin="$HOME/Library/Application Support/jackbird/bin/jackbird-service"
    system_unit="$ROOT/Library/LaunchDaemons/es.germade.jackbird.service.plist"
    system_bin="$ROOT/Library/Application Support/jackbird/bin/jackbird-service" ;;
  *)
    logon_unit="$HOME/.config/systemd/user/jackbird.service"
    logon_bin="$HOME/.local/share/jackbird/bin/jackbird-service"
    system_unit="$ROOT/etc/systemd/system/jackbird.service"
    system_bin="$ROOT/usr/local/lib/jackbird/jackbird-service" ;;
esac
way=""
[ ! -e "$logon_unit" ] || way=logon
[ -n "$way" ] || [ ! -e "$system_unit" ] || way=system
put() { mkdir -p "$(dirname "$1")" "$(dirname "$2")"; : > "$1"; cp "$0" "$2.new"; mv "$2.new" "$2"; chmod +x "$2"; }
case "\${1:-}" in
  --version) echo "$VERSION"; exit 0 ;;
  status) echo "{\\"binaryVersion\\":\\"$VERSION\\",\\"installed\\":\\"$way\\",\\"port\\":4646,\\"running\\":true,\\"version\\":\\"$VERSION\\"}"; exit 0 ;;
esac
echo "$VERSION $*" >> "$LOG"
case "$1" in
  install)
    [ -z "$way" ] || { echo "jackbird-service: install: the service is installed already" >&2; exit 1; }
    case " $* " in
      *" --with-system "*) put "$system_unit" "$system_bin" ;;
      *) put "$logon_unit" "$logon_bin" ;;
    esac ;;
  update)
    [ -n "$way" ] || { echo "jackbird-service: update: the service is not installed" >&2; exit 1; }
    if [ "$way" = logon ]; then put "$logon_unit" "$logon_bin"; else put "$system_unit" "$system_bin"; fi ;;
  uninstall)
    if [ "$way" = logon ]; then rm -f "$logon_unit" "$logon_bin"; fi
    if [ "$way" = system ]; then rm -f "$system_unit" "$system_bin"; fi ;;
esac
echo "{}"
`
  );
  chmodSync(path, 0o755);
  return path;
}

const old = standIn("0.1.0");
const fresh = standIn("0.2.0");

/** Runs the script; its exit code, what it said, and the commands the stand-in was given since. */
function setup(args, { binary = fresh, env = {} } = {}) {
  writeFileSync(log, "");
  const run = spawnSync("sh", [script, ...args], {
    encoding: "utf8",
    // No terminal: a session of its own (the check may be run from one).
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: `${tools}:${process.env.PATH}`, HOME: home, NO_COLOR: "1", JACKBIRD_SETUP_ROOT: root, JACKBIRD_SETUP_BINARY: binary, ...env }
  });
  const commands = readFileSync(log, "utf8").split("\n").filter(Boolean);
  return { code: run.status, out: run.stdout, err: run.stderr, commands: commands.filter((line) => line !== "sudo"), sudo: commands.includes("sudo") };
}

const person = spawnSync("id", ["-un"], { encoding: "utf8" }).stdout.trim();
const uid = spawnSync("id", ["-u"], { encoding: "utf8" }).stdout.trim();
const isRoot = uid === "0";
const systemFlags = `--user ${person} --uid ${uid} --home ${home}`;
let checks = 0;
const check = (name, run) => {
  run();
  checks += 1;
  console.log(`ok  ${name}`);
};

try {
  check("nothing installed: status says so, update and uninstall do nothing", () => {
    const status = setup(["status"]);
    assert.equal(status.code, 0, status.err);
    assert.match(status.out, /is not installed/);
    const update = setup(["update"]);
    assert.equal(update.code, 1);
    assert.match(update.err, /not installed/);
    assert.deepEqual(update.commands, []);
    const uninstall = setup(["uninstall", "--yes"]);
    assert.equal(uninstall.code, 0);
    assert.match(uninstall.out, /nothing to uninstall/);
    assert.deepEqual(uninstall.commands, []);
  });

  check("no command and no terminal: the usage, nothing done", () => {
    const run = setup([]);
    assert.equal(run.code, 2);
    assert.match(run.out, /usage: setup\.sh/);
    assert.deepEqual(run.commands, []);
  });

  check("install --logon: the binary's own install, with no administrator", () => {
    const run = setup(["install", "--logon"], { binary: old });
    assert.equal(run.code, 0, run.err);
    assert.deepEqual(run.commands, ["0.1.0 install"]);
    assert.equal(run.sudo, false);
    assert.match(run.out, /0\.1\.0 is installed \(at logon\) on http:\/\/localhost:4646/);
    assert.match(run.out, /jackbird-service" setup/);
    assert.match(setup(["status"]).out, /installed at logon, 0\.1\.0, running on http:\/\/localhost:4646/);
  });

  check("install again: refused, nothing run", () => {
    const run = setup(["install"]);
    assert.equal(run.code, 1);
    assert.match(run.err, /installed already \(at logon\)/);
    assert.deepEqual(run.commands, []);
  });

  check("update: the new binary's update; then nothing to update", () => {
    const run = setup(["update"]);
    assert.equal(run.code, 0, run.err);
    assert.deepEqual(run.commands, ["0.2.0 update"]);
    assert.match(run.out, /from 0\.1\.0 to 0\.2\.0/);
    const again = setup(["update"]);
    assert.equal(again.code, 0);
    assert.match(again.out, /0\.2\.0 already/);
    assert.deepEqual(again.commands, []);
  });

  check("reinstall: uninstalled and installed again, the way it was", () => {
    const run = setup(["reinstall"]);
    assert.equal(run.code, 0, run.err);
    assert.deepEqual(run.commands, ["0.2.0 uninstall", "0.2.0 install"]);
    assert.match(setup(["status"]).out, /installed at logon/);
  });

  check("uninstall: asks, and without an answer leaves it; with --yes the installed binary uninstalls itself", () => {
    const asked = setup(["uninstall"]);
    assert.equal(asked.code, 0);
    assert.match(asked.out, /Left as it is/);
    assert.deepEqual(asked.commands, []);
    const run = setup(["uninstall", "--yes"], { binary: old });
    assert.equal(run.code, 0, run.err);
    assert.deepEqual(run.commands, ["0.2.0 uninstall"]);
    assert.match(setup(["status"]).out, /is not installed/);
  });

  check("install (with the system, the default): as an administrator, for the person", () => {
    const run = setup(["install"]);
    assert.equal(run.code, 0, run.err);
    assert.deepEqual(run.commands, [`0.2.0 install --with-system ${systemFlags}`]);
    assert.equal(run.sudo, !isRoot);
    assert.match(run.out, /installed \(with the system\)/);
    assert.ok(existsSync(join(root, process.platform === "darwin" ? "Library/LaunchDaemons/es.germade.jackbird.service.plist" : "etc/systemd/system/jackbird.service")));
  });

  check("reinstall --logon: from the system's way to the logon's", () => {
    const run = setup(["reinstall", "--logon"]);
    assert.equal(run.code, 0, run.err);
    assert.deepEqual(run.commands, [`0.2.0 uninstall ${systemFlags}`, "0.2.0 install"]);
    assert.match(setup(["status"]).out, /installed at logon/);
    assert.equal(setup(["uninstall", "-y"]).code, 0);
  });

  check("a release that is not one, and an unknown word: refused", () => {
    const version = setup(["install", "--version", "latest; rm -rf /"]);
    assert.equal(version.code, 1);
    assert.match(version.err, /not a release/);
    assert.equal(setup(["remove"]).code, 2);
    assert.equal(setup(["--help"]).code, 0);
  });

  console.log(`setup.sh: ${checks} checks passed`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
