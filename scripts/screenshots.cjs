#!/usr/bin/env node
// The screenshots of the README (docs/screenshots/) and of the landing page, taken from the real
// app over a made-up library, so they always show the interface as it is.
//
//   node scripts/screenshots.cjs [app URL] [out]
//
// The app URL defaults to the dev server (http://localhost:8666/, `npm run dev`); a build served
// anywhere does as well. The images go to `out`, docs/screenshots/ by default. The release
// workflow (release.yml) runs it on each release's own build and attaches the images to the
// release, where deploy.yml and the README take them from.
//
// Among them, the faceplate's deck and the compact player's card (in the page, the floating
// window's API removed), in both tones, for the landing page's hero.
//
// And the demo as the landing page embeds it (`?embed`, `?embed=phone`), in both tones, at the
// iframes' own size, see-through round the windows: the landing page shows it until the demo
// itself has drawn over it, so the two match (embed-*.png). The sample music is served from
// `samples/`, which a build does not hold. `JACKBIRD_SHOTS=embed` takes these alone (no ffmpeg).
//
// It builds the library in a temporary folder: five invented albums (artists, titles and genres
// made up; covers drawn on a canvas, abstract shapes; tones and noise from ffmpeg, so the spectrum
// has something to show), tagged by ffmpeg. Chromium (Playwright) copies it into the page's
// origin-private file system, whose handle is a real FileSystemDirectoryHandle, and
// `showDirectoryPicker` returns it: the app opens, reads and plays real files, as with a folder
// picked by hand. Needs ffmpeg. Images at device scale factor 2.
//
// See RECORD/2026-11-12.landing-page.WIP.md.

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright");

const app = process.argv[2] ?? "http://localhost:8666/";
const out = path.resolve(process.argv[3] ?? path.join(__dirname, "../docs/screenshots"));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "jackbird-shots-"));
const library = path.join(work, "Music");

const ALBUMS = [
  { artist: "Ines Halloway", album: "Copper Wires", year: 2021, genre: "Synthpop", hue: 22, tracks: ["Copper Wires", "Night Shift", "Analogue Heart", "Telephone Weather", "Closing Time"] },
  { artist: "Kestrel Lane", album: "Low Tide Radio", year: 2019, genre: "Dream Pop", hue: 200, tracks: ["Harbour Lights", "Salt in the Static", "Low Tide Radio", "Paper Boats", "Undertow", "Last Ferry Home"] },
  { artist: "Mono Harbour", album: "Signal to Noise", year: 2014, genre: "Post-Rock", hue: 150, tracks: ["Carrier", "Interference", "Long Wave", "Signal to Noise"] },
  { artist: "Orla Venn", album: "Field Notes", year: 2023, genre: "Folk", hue: 95, tracks: ["Moss", "Lichen", "Slow Water", "Field Notes"] },
  { artist: "The Quiet Parade", album: "Night Bus Atlas", year: 2016, genre: "Indie Rock", hue: 265, discs: [["Route 9", "Sodium Street", "Window Seat"], ["Terminus", "Lamplighters", "Morning Depot"]] }
];

const slug = (text) => text.replace(/[^A-Za-z0-9]+/g, " ").trim();

// ---- the covers: abstract shapes on a canvas -------------------------------------------------

async function drawCovers(browser) {
  const page = await browser.newPage();
  const covers = await page.evaluate((albums) => {
    return albums.map(({ hue }, at) => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 600;
      const c = canvas.getContext("2d");
      const ground = c.createLinearGradient(0, 0, 0, 600);
      ground.addColorStop(0, `hsl(${hue} 45% ${at % 2 ? 22 : 70}%)`);
      ground.addColorStop(1, `hsl(${(hue + 40) % 360} 55% ${at % 2 ? 12 : 45}%)`);
      c.fillStyle = ground;
      c.fillRect(0, 0, 600, 600);
      // Each album its own figure: a sun, bands, a constellation, rings, a grid.
      c.lineWidth = 6;
      if (at === 0) {
        for (let i = 0; i < 7; i += 1) {
          c.fillStyle = `hsl(${(hue + i * 12) % 360} 80% ${55 + i * 4}%)`;
          c.fillRect(0, 160 + i * 40, 600, 22);
        }
      } else if (at === 1) {
        c.fillStyle = "hsl(30 90% 70%)";
        c.beginPath();
        c.arc(300, 330, 120, Math.PI, 0);
        c.fill();
        c.fillStyle = `hsl(${hue} 50% 25%)`;
        c.fillRect(0, 330, 600, 270);
        c.strokeStyle = "hsl(30 90% 70% / .5)";
        for (let i = 0; i < 6; i += 1) {
          c.beginPath();
          c.moveTo(240 + i * 4, 360 + i * 30);
          c.lineTo(360 - i * 4, 360 + i * 30);
          c.stroke();
        }
      } else if (at === 2) {
        c.strokeStyle = "hsl(0 0% 95% / .85)";
        for (let i = 1; i < 9; i += 1) {
          c.beginPath();
          c.arc(300, 300, i * 34, 0, Math.PI * 2);
          c.stroke();
        }
      } else if (at === 3) {
        c.fillStyle = "hsl(45 70% 85%)";
        for (let i = 0; i < 5; i += 1) {
          c.beginPath();
          c.ellipse(140 + i * 80, 420 - (i % 2) * 60, 30, 110, 0.4, 0, Math.PI * 2);
          c.fill();
        }
      } else {
        c.fillStyle = "#101828";
        c.fillRect(0, 0, 600, 600);
        c.strokeStyle = "hsl(45 90% 65%)";
        c.fillStyle = "hsl(45 90% 75%)";
        const stars = [[120, 420], [210, 300], [300, 340], [380, 200], [470, 150]];
        c.beginPath();
        stars.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y)));
        c.stroke();
        stars.forEach(([x, y]) => {
          c.beginPath();
          c.arc(x, y, 10, 0, Math.PI * 2);
          c.fill();
        });
      }
      return canvas.toDataURL("image/png").split(",")[1];
    });
  }, ALBUMS);
  await page.close();
  return covers.map((data) => Buffer.from(data, "base64"));
}

// ---- the tracks: tones and noise, tagged ----------------------------------------------------

function makeLibrary(covers) {
  fs.mkdirSync(library, { recursive: true });
  ALBUMS.forEach((album, at) => {
    const folder = path.join(library, album.artist, `${album.year} - ${album.album}`);
    const cover = path.join(work, `cover-${at}.png`);
    fs.writeFileSync(cover, covers[at]);
    const discs = album.discs ?? [album.tracks];
    discs.forEach((titles, disc) => {
      const dir = album.discs ? path.join(folder, `Disc ${disc + 1}`) : folder;
      fs.mkdirSync(dir, { recursive: true });
      titles.forEach((title, index) => {
        const seconds = 28 + ((at * 7 + index * 5) % 19);
        const tone = 110 * Math.pow(2, ((at * 3 + index * 5) % 24) / 12);
        const file = path.join(dir, `${String(index + 1).padStart(2, "0")} ${slug(title)}.mp3`);
        execFileSync("ffmpeg", [
          "-loglevel", "error", "-y",
          "-f", "lavfi", "-i", `sine=frequency=${tone.toFixed(1)}:duration=${seconds}`,
          "-f", "lavfi", "-i", `anoisesrc=d=${seconds}:c=pink:a=0.25`,
          "-f", "lavfi", "-i", `sine=frequency=${(tone * 3).toFixed(1)}:duration=${seconds}`,
          "-i", cover,
          "-filter_complex", "[0][1][2]amix=inputs=3,volume=2[a]",
          "-map", "[a]", "-map", "3",
          "-c:a", "libmp3lame", "-b:a", "96k", "-c:v", "png", "-disposition:v", "attached_pic",
          "-id3v2_version", "3",
          "-metadata", `title=${title}`, "-metadata", `artist=${album.artist}`, "-metadata", `album_artist=${album.artist}`,
          "-metadata", `album=${album.album}`, "-metadata", `date=${album.year}`, "-metadata", `genre=${album.genre}`,
          "-metadata", `track=${index + 1}/${titles.length}`, "-metadata", `disc=${disc + 1}/${discs.length}`,
          file
        ]);
      });
    });
  });
}

function listFiles(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? listFiles(full, base) : [path.relative(base, full)];
  });
}

// ---- the app --------------------------------------------------------------------------------

/** A page of the app whose folder picker returns the made-up library, copied into its OPFS. */
async function openApp(browser, { tone, ...options }) {
  const page = await browser.newPage(options);
  page.on("pageerror", (error) => console.error("page error:", error.message));
  const files = listFiles(library);
  await page.route("**/__library/**", (route) => {
    const relative = decodeURIComponent(new URL(route.request().url()).pathname.replace(/^.*\/__library\//, ""));
    route.fulfill({ body: fs.readFileSync(path.join(library, relative)), contentType: "audio/mpeg" });
  });
  await page.addInitScript(({ files, tone }) => {
    localStorage.setItem("mp3-manager.theme", tone);
    localStorage.setItem("mp3-manager.language", "en");
    // The compact player in the page itself (not a floating window), so it can be captured.
    delete window.documentPictureInPicture;
    window.showDirectoryPicker = async () => {
      const root = await navigator.storage.getDirectory();
      await root.removeEntry("Music", { recursive: true }).catch(() => undefined);
      const music = await root.getDirectoryHandle("Music", { create: true });
      for (const file of files) {
        const parts = file.split("/");
        let dir = music;
        for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part, { create: true });
        const handle = await dir.getFileHandle(parts.at(-1), { create: true });
        const writable = await handle.createWritable();
        await writable.write(await (await fetch(`/__library/${file.split("/").map(encodeURIComponent).join("/")}`)).blob());
        await writable.close();
      }
      return music;
    };
  }, { files, tone });
  await page.goto(app);
  await page.waitForSelector(".wordmark, .faceplate");
  // The key, by its role: the display's marquee says "choose a folder" too, and runs.
  await page.getByRole("button", { name: /choose a folder/i }).first().click();
  await page.getByText("Night Bus Atlas").first().waitFor({ timeout: 60000 });
  await page.waitForTimeout(800);
  return page;
}

// ---- the demo as the landing page embeds it ---------------------------------------------------

const samples = path.resolve(__dirname, "../samples");

/**
 * The embedded demo's iframes, as the landing page sizes them where its content is 1024px wide
 * (landing/landing.css): the stage's frame, 1.5rem (27px, the root being 18px) wider each side,
 * and the phone's column, 18rem.
 */
const EMBEDS = [
  { kind: "", name: "embed", width: 1078, height: 724 },
  { kind: "phone", name: "embed-phone", width: 324, height: 551 }
];

/**
 * The demo in an iframe of `embed`'s size, in a page of the app's origin (the demo tells its parent
 * it has drawn, `jackbird:drawn`, to that origin alone), captured see-through round its windows, as
 * the landing page shows it. The windows are captured the moment they have drawn, as the landing
 * page shows them, their marquees at their start. The phone follows the windows' player on the
 * landing page (src/lib/mirror.ts), so its page holds the windows too, and it is captured once it
 * shows their track. The phone's clock is fixed at 9:41.
 */
async function captureEmbed(browser, embed, tone) {
  const windows = EMBEDS[0];
  const phone = embed.kind === "phone";
  const page = await browser.newPage({
    viewport: { width: Math.max(windows.width, embed.width), height: windows.height + (phone ? embed.height : 0) },
    deviceScaleFactor: 2,
    locale: "en-US"
  });
  page.on("pageerror", (error) => console.error("page error:", error.message));
  await page.clock.setFixedTime(new Date("2026-01-05T09:41:00"));
  await page.route("**/samples/**", (route) => {
    const name = decodeURIComponent(new URL(route.request().url()).pathname.replace(/^.*\/samples\//, ""));
    const file = path.join(samples, name);
    if (!file.startsWith(samples + path.sep) || !fs.existsSync(file)) return route.fulfill({ status: 404 });
    route.fulfill({ body: fs.readFileSync(file), contentType: name.endsWith(".json") ? "application/json" : "audio/mpeg" });
  });
  const host = new URL("__embed-host.html", app).href;
  const frame = ({ kind, width, height }) =>
    `<iframe id="${kind || "windows"}" src="./?embed${kind ? `=${kind}` : ""}&lang=en&tone=${tone === "graphite" ? "dark" : "light"}" style="display:block;width:${width}px;height:${height}px;border:0;background:transparent"></iframe>`;
  await page.route(host, (route) =>
    route.fulfill({
      contentType: "text/html",
      // Each demo says it has drawn to its parent: this page counts them on its body.
      body: `<!doctype html><html><body style="margin:0;background:transparent" data-drawn="0"><script>addEventListener("message", (event) => { if (event.data?.type === "jackbird:drawn") document.body.dataset.drawn = String(Number(document.body.dataset.drawn) + 1); });</script>${frame(windows)}${phone ? frame(embed) : ""}</body></html>`
    })
  );
  await page.goto(host);
  await page.waitForSelector(`body[data-drawn="${phone ? 2 : 1}"]`, { state: "attached", timeout: 60000 });
  if (phone) {
    // Its rows show the track queued (playing or paused) once it follows the windows.
    await page.frameLocator("#phone").locator(".row.playing").first().waitFor({ timeout: 30000 });
    await page.waitForTimeout(300);
  }
  await page.locator(`#${embed.kind || "windows"}`).screenshot({ path: path.join(out, `${embed.name}-${tone}.png`), omitBackground: true });
  console.log(`${embed.name} in ${tone}`);
  await page.close();
}

async function captureEmbeds(browser) {
  for (const embed of EMBEDS) {
    for (const tone of ["silver", "graphite"]) await captureEmbed(browser, embed, tone);
  }
}

/** Plays a track by its title (a click on its row plays it) and lets the music run a little. */
async function play(page, title, seconds = 4) {
  await page.getByText(title, { exact: true }).last().click();
  await page.waitForFunction(() => document.querySelector(".lcd-spectrum canvas"), null, { timeout: 15000 });
  await page.waitForTimeout(seconds * 1000);
}

async function main() {
  const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
  fs.mkdirSync(out, { recursive: true });
  await captureEmbeds(browser);
  if (process.env.JACKBIRD_SHOTS === "embed") {
    await browser.close();
    fs.rmSync(work, { recursive: true, force: true });
    console.log("screenshots in", out);
    return;
  }
  console.log("drawing covers and making the tracks in", work);
  makeLibrary(await drawCovers(browser));
  fs.mkdirSync(out, { recursive: true });
  const desktop = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 };

  for (const [tone, album, title] of [["light", "Low Tide Radio", "Salt in the Static"], ["dark", "Night Bus Atlas", "Lamplighters"]]) {
    const page = await openApp(browser, { tone, ...desktop });
    await page.getByText(album).first().click();
    await page.waitForTimeout(600);
    await play(page, title, 6);
    const name = tone === "light" ? "silver" : "graphite";
    await page.screenshot({ path: path.join(out, `library-${name}.png`) });
    // The faceplate's deck alone (wordmark, display, keys), for the landing page's hero.
    await page.locator(".faceplate .deck").first().screenshot({ path: path.join(out, `faceplate-${name}.png`) });
    console.log("library and faceplate in", name);

    if (tone === "light") {
      // Three tracks selected, then their edit dialog.
      await page.getByText("Copper Wires").first().click();
      await page.waitForTimeout(600);
      for (const title of ["Night Shift", "Analogue Heart", "Telephone Weather"]) {
        await page.locator("tr", { hasText: title }).locator(".pick-cell").first().click();
      }
      await page.getByRole("button", { name: /edit/i }).first().click();
      await page.waitForTimeout(1000);
      await page.screenshot({ path: path.join(out, "edit-dialog.png") });
      console.log("edit dialog");
      await page.keyboard.press("Escape");
      await page.waitForTimeout(600);
    }
    // The compact player, the card, as its window shows it (22 by 11), for the landing page's
    // hero; the track still playing.
    await page.keyboard.press("Control+Shift+M");
    await page.setViewportSize({ width: 440, height: 220 });
    // As the landing page's live player draws it: no key back to the full view (the page's own
    // way back, which a picture of it on the landing page has nowhere to go to).
    await page.addStyleTag({ content: ".compact .keys .side:first-child { visibility: hidden; }" });
    // Past the format the display shows a song's first two seconds: the spectrum.
    await page.waitForTimeout(3000);
    await page.locator(".compact").first().screenshot({ path: path.join(out, `compact-${name}.png`) });
    console.log("compact player in", name);
    await page.close();
  }

  const phone = await openApp(browser, { tone: "light", viewport: { width: 390, height: 664 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await phone.getByText("Copper Wires").first().click().catch(() => undefined);
  await phone.waitForTimeout(600);
  await play(phone, "Analogue Heart", 4);
  await phone.screenshot({ path: path.join(out, "phone.png") });
  console.log("phone");

  await browser.close();
  fs.rmSync(work, { recursive: true, force: true });
  console.log("screenshots in", out);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
