// The frontend the shell serves (src-tauri/frontend/): the web build as it is, and the E0 check
// page, which the web build and the Pages deploy do not get. Tauri runs it after `npm run build`
// (beforeBuildCommand in tauri.conf.json).
import { cpSync, existsSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const path = (relative) => fileURLToPath(new URL(relative, import.meta.url));
const dist = path("../../dist/");
const out = path("../frontend/");
if (!existsSync(dist)) {
  console.error("No dist/: run npm run build first.");
  process.exit(1);
}
rmSync(out, { recursive: true, force: true });
cpSync(dist, out, { recursive: true });
cpSync(path("./e0-check.html"), path("../frontend/e0-check.html"));
console.log("src-tauri/frontend: dist/ and e0-check.html");
