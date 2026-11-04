// E0's unattended run: starts the shell with the check's environment, waits for both windows'
// reports (90 s at most), prints them, writes them to e0-report.json beside this script and, in
// GitHub Actions, to the job's summary. Fails only when no report came at all.
//   node src-tauri/e0/run-check.mjs <path to the jackbird binary> [audio files...]
// Linux needs a display: run it under xvfb-run there.
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = (relative) => fileURLToPath(new URL(relative, import.meta.url));
const [binary, ...given] = process.argv.slice(2);
if (!binary || !existsSync(binary)) {
  console.error(`No binary at ${binary}`);
  process.exit(2);
}
const files = given.length ? given : [here("./fixtures/tone.mp3"), here("./fixtures/tone.flac")];
const reportFile = here("./e0-report.jsonl");
rmSync(reportFile, { force: true });

const child = spawn(binary, [], {
  env: { ...process.env, JACKBIRD_E0_FILES: files.join("|"), JACKBIRD_E0_REPORT: reportFile, JACKBIRD_E0_EXIT: "1" },
  stdio: ["ignore", "inherit", "inherit"]
});
const timer = setTimeout(() => {
  console.error("No end after 90 s: stopping the shell.");
  child.kill();
}, 90_000);
const code = await new Promise((resolve) => child.on("exit", (exitCode, signal) => resolve(exitCode ?? signal)));
clearTimeout(timer);

const reports = existsSync(reportFile) ? readFileSync(reportFile, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
writeFileSync(here("./e0-report.json"), JSON.stringify({ platform: process.platform, arch: process.arch, exit: code, reports }, null, 2));
console.log(JSON.stringify(reports, null, 2));

if (process.env.GITHUB_STEP_SUMMARY) {
  const main = reports.find((r) => r.window === "main");
  const check = reports.find((r) => r.window === "check");
  const lines = [`### E0 check on ${process.platform} (${process.arch})`, ""];
  lines.push(main ? `- Main window: jq79 drew the app: **${main.faceplate && main.display}**; File System Access API: ${main.fileSystemAccess}; errors: ${main.errors.length ? main.errors.join(" · ") : "none"}` : "- Main window: no report");
  if (check && check.files) {
    lines.push(`- canPlayType MP3 / FLAC: ${check.environment.canPlay.mp3 || "no"} / ${check.environment.canPlay.flac || "no"}`);
    for (const f of check.files) {
      lines.push(`- ${f.path.split(/[\\/]/).pop()}: fetched through the asset protocol: ${f.fetch.status ?? f.fetch.error}`);
      for (const m of f.modes) {
        lines.push(`  - as ${m.mode}: ${m.error || (m.playStarted ? `started, +${m.timeAdvanced} s, analyser max ${m.analyserMax}, ${m.contextState} at ${m.sampleRate} Hz` : `${m.playError}${m.mediaError ? `, media error ${m.mediaError}` : ""}`)}`);
      }
    }
  } else {
    lines.push(`- Check window: ${check ? check.error : "no report"}`);
  }
  lines.push("", `<details><summary>Reports</summary>\n\n\`\`\`json\n${JSON.stringify(reports, null, 2)}\n\`\`\`\n</details>`, "");
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join("\n"));
}
process.exit(reports.length ? 0 : 1);
