#!/usr/bin/env node
// The app's icons, drawn as the tab's icon is (src/lib/favicon.ts): the logo's shape lit in the
// display's ink on the display's glass. Silver: dark ink on the olive LCD; Graphite: glowing aqua
// on the black VFD (the colours are tokens.css's --mm-display-bg and --mm-display-fg).
//
//   node scripts/app-icons.mjs
//
// - macOS, Windows and Linux (src-tauri/icons: 32x32, 128x128, 128x128@2x, icon.png, icon.icns,
//   icon.ico) and iOS (src-tauri/icons/ios): Graphite, the one an icon file can have. Made by
//   `tauri icon` from a 1024px source drawn here: for the desktop a rounded square inside the
//   usual margin; for iOS the glass full-bleed (iOS rounds it).
// - Android (src-tauri/icons/android, copied into the generated project by mobile.yml and
//   phone-release.yml): adaptive layers, Silver by day and Graphite at night (`-night`
//   resources, for the launchers that honour them), and the bird in one colour for Android 13's
//   themed icons. The legacy icons (before Android 8) too.
//
// The bird is centred on the smallest circle that holds it, so its margin is the same all round
// (its left wing reaches furthest), and fitted inside it. Needs Playwright's Chromium.
// See RECORD/2026-11-03.deck-design-system.WIP.md (2026-11-12 23:40 UTC).

import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const icons = join(repo, "src-tauri/icons");
const logo = readFileSync(join(repo, "src/assets/brand/jackbird-metal.svg"), "utf8");

// tokens.css: the display's glass and ink, in each tone.
const TONES = {
  silver: { ground: "#bfc9ac", ink: "#1d2916", glow: false },
  graphite: { ground: "#061210", ink: "#5ff2d6", glow: true }
};

// Android's densities: the adaptive layer (108dp) and the legacy icon (48dp).
const DENSITIES = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };

/**
 * What one image is: its size; the tone (or "white", the themed icon's shape); whether it has the
 * glass ("square": a rounded square inside the desktop's margin; "full": full-bleed; "circle"; or
 * none, a transparent layer); and the circle the bird fits in, as a share of the size.
 */
const draw = (page, spec) =>
  page.evaluate(async ({ svg, spec, tone }) => {
    const image = new Image();
    image.src = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`;
    await image.decode();
    const { size } = spec;

    // The bird's shape at a reference scale, and the smallest circle round it (searched on a grid).
    const REF = 512;
    const probe = document.createElement("canvas");
    const scale0 = REF / Math.max(image.naturalWidth, image.naturalHeight);
    probe.width = Math.round(image.naturalWidth * scale0);
    probe.height = Math.round(image.naturalHeight * scale0);
    const p = probe.getContext("2d", { willReadFrequently: true });
    p.drawImage(image, 0, 0, probe.width, probe.height);
    const data = p.getImageData(0, 0, probe.width, probe.height).data;
    const points = [];
    for (let y = 0; y < probe.height; y += 2) {
      for (let x = 0; x < probe.width; x += 2) if (data[(y * probe.width + x) * 4 + 3] > 16) points.push([x, y]);
    }
    const reach = (cx, cy) => points.reduce((far, [x, y]) => Math.max(far, Math.hypot(x - cx, y - cy)), 0);
    let best = { cx: probe.width / 2, cy: probe.height / 2, r: reach(probe.width / 2, probe.height / 2) };
    for (let step = 32; step >= 1; step /= 2) {
      for (let improved = true; improved; ) {
        improved = false;
        for (const [dx, dy] of [[step, 0], [-step, 0], [0, step], [0, -step]]) {
          const r = reach(best.cx + dx, best.cy + dy);
          if (r < best.r) {
            best = { cx: best.cx + dx, cy: best.cy + dy, r };
            improved = true;
          }
        }
      }
    }

    // The shape, in the ink, its circle's centre on the image's and its radius `fit` of the size / 2.
    const scale = (size * spec.fit) / 2 / best.r;
    const shape = document.createElement("canvas");
    shape.width = shape.height = size;
    const s = shape.getContext("2d");
    const w = probe.width * scale;
    const h = probe.height * scale;
    s.drawImage(image, size / 2 - best.cx * scale, size / 2 - best.cy * scale, w, h);
    s.globalCompositeOperation = "source-in";
    s.fillStyle = tone ? tone.ink : "#ffffff";
    s.fillRect(0, 0, size, size);

    const icon = document.createElement("canvas");
    icon.width = icon.height = size;
    const c = icon.getContext("2d");
    if (spec.glass && tone) {
      c.fillStyle = tone.ground;
      c.beginPath();
      if (spec.glass === "square") {
        // The desktop's icon grid: the body 80% of the image, its corners 22.5% of it.
        const inset = size * 0.1;
        c.roundRect(inset, inset, size - inset * 2, size - inset * 2, (size - inset * 2) * 0.225);
      } else if (spec.glass === "circle") {
        c.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
      } else {
        c.rect(0, 0, size, size);
      }
      c.fill();
    }
    if (tone?.glow) {
      c.shadowColor = tone.ink;
      c.shadowBlur = size * 0.04;
    }
    c.drawImage(shape, 0, 0);
    return icon.toDataURL("image/png").split(",")[1];
  }, { svg: logo, spec, tone: spec.tone === "white" ? null : TONES[spec.tone] });

const write = (path, base64) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, Buffer.from(base64, "base64"));
};

const browser = await chromium.launch();
const page = await browser.newPage();
const work = mkdtempSync(join(tmpdir(), "jackbird-icons-"));
try {
  // Desktop and iOS: Graphite, through `tauri icon`.
  write(join(work, "desktop.png"), await draw(page, { size: 1024, tone: "graphite", glass: "square", fit: 0.6 }));
  write(join(work, "ios.png"), await draw(page, { size: 1024, tone: "graphite", glass: "full", fit: 0.66 }));
  const tauri = (input, out) => execFileSync("npx", ["tauri", "icon", input, "-o", out], { cwd: repo, stdio: "ignore" });
  tauri(join(work, "desktop.png"), join(work, "desktop"));
  tauri(join(work, "ios.png"), join(work, "ios"));
  for (const file of ["32x32.png", "128x128.png", "128x128@2x.png", "icon.png", "icon.icns", "icon.ico"]) {
    cpSync(join(work, "desktop", file), join(icons, file));
  }
  rmSync(join(icons, "ios"), { recursive: true, force: true });
  cpSync(join(work, "ios", "ios"), join(icons, "ios"), { recursive: true });

  // Android: the adaptive layers and the legacy icons, Silver by day and Graphite at night.
  const android = join(icons, "android");
  rmSync(android, { recursive: true, force: true });
  for (const [density, factor] of Object.entries(DENSITIES)) {
    const layer = Math.round(108 * factor);
    const legacy = Math.round(48 * factor);
    for (const [qualifier, tone] of [["", "silver"], ["-night", "graphite"]]) {
      const folder = join(android, `mipmap${qualifier}-${density}`);
      // The layer is masked to at least a circle 61% across: the bird inside 46% of it (three
      // quarters of that circle, a margin all round).
      write(join(folder, "ic_launcher_foreground.png"), await draw(page, { size: layer, tone, fit: 0.46 }));
      write(join(folder, "ic_launcher.png"), await draw(page, { size: legacy, tone, glass: "full", fit: 0.66 }));
      write(join(folder, "ic_launcher_round.png"), await draw(page, { size: legacy, tone, glass: "circle", fit: 0.56 }));
    }
    write(join(android, `mipmap-${density}`, "ic_launcher_monochrome.png"), await draw(page, { size: layer, tone: "white", fit: 0.46 }));
  }
  const adaptive = `<?xml version="1.0" encoding="utf-8"?>
<!-- The launcher icon, as the tab's: the bird lit in the display's ink on its glass (Silver by
     day, Graphite at night), and in one colour for Android 13's themed icons. Made by
     scripts/app-icons.mjs. -->
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
  <background android:drawable="@color/ic_launcher_background"/>
  <foreground android:drawable="@mipmap/ic_launcher_foreground"/>
  <monochrome android:drawable="@mipmap/ic_launcher_monochrome"/>
</adaptive-icon>
`;
  write(join(android, "mipmap-anydpi-v26", "ic_launcher.xml"), Buffer.from(adaptive).toString("base64"));
  write(join(android, "mipmap-anydpi-v26", "ic_launcher_round.xml"), Buffer.from(adaptive).toString("base64"));
  const colour = (value) => `<?xml version="1.0" encoding="utf-8"?>
<resources>
  <color name="ic_launcher_background">${value}</color>
</resources>
`;
  write(join(android, "values", "ic_launcher_background.xml"), Buffer.from(colour(TONES.silver.ground)).toString("base64"));
  write(join(android, "values-night", "ic_launcher_background.xml"), Buffer.from(colour(TONES.graphite.ground)).toString("base64"));
  console.log("Icons written: src-tauri/icons (desktop, ios, android)");
} finally {
  await browser.close();
  rmSync(work, { recursive: true, force: true });
}
