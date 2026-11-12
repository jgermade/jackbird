// The landing's few moving parts: the tone's selector (the system's, Silver or Graphite,
// remembered; the page's screenshots follow it) and the tab's icon lit like the display, as in the
// app (src/lib/favicon.ts).

const root = document.documentElement;
const KEY = "jackbird-landing-tone";

// ---- the tone -----------------------------------------------------------------------------

const toneKeys = [...document.querySelectorAll(".tone")];
const systemDark = matchMedia("(prefers-color-scheme: dark)");

/** What is chosen: "light", "dark", or "auto" (nothing kept: the system's). */
function chosenTone() {
  let saved = null;
  try { saved = localStorage.getItem(KEY); } catch {}
  return saved === "light" || saved === "dark" ? saved : "auto";
}

/** The chosen key down, the only one in the tab order; the tab's icon in the tone. */
function showTone() {
  const chosen = chosenTone();
  for (const key of toneKeys) {
    const on = key.dataset.choice === chosen;
    key.setAttribute("aria-checked", String(on));
    key.tabIndex = on ? 0 : -1;
  }
  drawFavicon();
}

/** Takes a choice: kept (automatic keeps nothing), the page turned to it, the embedded apps told. */
function chooseTone(choice) {
  try {
    if (choice === "auto") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, choice);
  } catch {}
  root.dataset.theme = choice === "auto" ? (systemDark.matches ? "dark" : "light") : choice;
  showTone();
  tellTone();
}

for (const key of toneKeys) {
  key.addEventListener("click", () => chooseTone(key.dataset.choice));
  // Left and right (and up and down) move the choice, as a group of radio buttons does.
  key.addEventListener("keydown", (event) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (!step) return;
    event.preventDefault();
    const next = toneKeys[(toneKeys.indexOf(key) + step + toneKeys.length) % toneKeys.length];
    chooseTone(next.dataset.choice);
    next.focus();
  });
}

// ---- the tab's icon -----------------------------------------------------------------------

const logo = new Image();
logo.src = "./brand/jackbird-metal.svg";
const SIZE = 64;

function drawFavicon() {
  if (!logo.complete || !logo.naturalWidth) return;
  const style = getComputedStyle(root);
  const ground = style.getPropertyValue("--mm-display-bg").trim();
  const ink = style.getPropertyValue("--mm-display-fg").trim();
  const glows = style.getPropertyValue("--mm-display-glow").trim() !== "none";

  const shape = document.createElement("canvas");
  shape.width = shape.height = SIZE;
  const s = shape.getContext("2d");
  const box = SIZE * .72;
  const scale = Math.min(box / logo.naturalWidth, box / logo.naturalHeight);
  const w = logo.naturalWidth * scale;
  const h = logo.naturalHeight * scale;
  s.drawImage(logo, (SIZE - w) / 2, (SIZE - h) / 2, w, h);
  s.globalCompositeOperation = "source-in";
  s.fillStyle = ink;
  s.fillRect(0, 0, SIZE, SIZE);

  const icon = document.createElement("canvas");
  icon.width = icon.height = SIZE;
  const c = icon.getContext("2d");
  c.fillStyle = ground;
  c.beginPath();
  c.roundRect(0, 0, SIZE, SIZE, SIZE * .2);
  c.fill();
  if (glows) {
    c.shadowColor = ink;
    c.shadowBlur = SIZE * .08;
  }
  c.drawImage(shape, 0, 0);

  const link = document.querySelector('link[rel="icon"]');
  link.type = "image/png";
  link.href = icon.toDataURL("image/png");
}
logo.addEventListener("load", drawFavicon);

// The system's tone, followed while the choice is automatic.
systemDark.addEventListener("change", () => {
  if (chosenTone() === "auto") chooseTone("auto");
});

showTone();

// ---- get it: the tabs ---------------------------------------------------------------------

const tabs = [...document.querySelectorAll('.tabs [role="tab"]')];

function showTab(tab) {
  for (const one of tabs) {
    const on = one === tab;
    one.setAttribute("aria-selected", String(on));
    one.tabIndex = on ? 0 : -1;
    document.getElementById(one.getAttribute("aria-controls")).hidden = !on;
  }
}

for (const tab of tabs) {
  tab.addEventListener("click", () => showTab(tab));
  // Left and right move between the tabs, as a tab list does.
  tab.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    const next = tabs[(tabs.indexOf(tab) + (event.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
    showTab(next);
    next.focus();
    event.preventDefault();
  });
}
if (location.hash === "#server") showTab(tabs[1]);

// ---- get it: this device's download, and the latest release's files -------------------------

/** The system this browser runs on, as the downloads name it; null where there is no app for it. */
function thisSystem() {
  const agent = navigator.userAgent;
  if (/Android/i.test(agent)) return "android";
  if (/iPhone|iPad|iPod/i.test(agent)) return null;
  // An iPad asks for the desktop site as a Mac: its touch gives it away.
  if (/Macintosh|Mac OS X/i.test(agent)) return navigator.maxTouchPoints > 1 ? null : "mac";
  if (/Windows/i.test(agent)) return "windows";
  if (/Linux|X11|CrOS/i.test(agent)) return "linux";
  return null;
}

const megabytes = (bytes) => `${Math.max(1, Math.round(bytes / 1e6))} MB`;

// This device's first: its first download (an AppImage before a .deb), with a ribbon.
const system = thisSystem();
const downloads = document.querySelector(".downloads");
const mine = system && downloads?.querySelector(`.download[data-os="${system}"]`);
if (mine) {
  mine.classList.add("mine");
  mine.dataset.ribbon = "Detected";
  downloads.prepend(mine);
}

// The latest release's files, by name: each link to its file, with its size; on any failure the
// links stay on the release's page.
fetch("https://api.github.com/repos/jgermade/jackbird/releases/latest", { headers: { Accept: "application/vnd.github+json" } })
  .then((response) => (response.ok ? response.json() : Promise.reject(new Error(String(response.status)))))
  .then((release) => {
    const assets = release.assets ?? [];
    for (const link of document.querySelectorAll("[data-asset]")) {
      const pattern = new RegExp(link.dataset.asset);
      const asset = assets.find((one) => pattern.test(one.name));
      if (!asset) continue;
      link.href = asset.browser_download_url;
      const file = link.querySelector(".file");
      if (file) file.textContent = `${file.textContent} · ${megabytes(asset.size)}`;
    }
    const version = document.querySelector(".release");
    if (version && release.tag_name) version.textContent = `jackbird ${release.tag_name}.`;
  })
  .catch(() => {});

// ---- the compact player over the window ------------------------------------------------------

// A release from before the compact player's capture: no such picture; it is left out.
for (const img of document.querySelectorAll(".mini img")) {
  img.addEventListener("error", () => img.closest(".mini")?.remove(), { once: true });
}

// ---- the stage: the window's tilt, and the app itself -------------------------------------------

const stage = document.querySelector(".stage");

/** The tilt for a pointer at (x, y), each 0 to 1 across the stage: the window turns to face it. */
function tiltFor(x, y) {
  return { x: `${((0.5 - y) * 2).toFixed(2)}deg`, y: `${((x - 0.5) * 3 - 1.5).toFixed(2)}deg` };
}

/** The window turns to face the pointer over the stage, and back to rest (the stylesheet's) when it leaves. */
function followPointer(area) {
  area.addEventListener("pointermove", (event) => {
    const box = area.getBoundingClientRect();
    const tilt = tiltFor((event.clientX - box.left) / box.width, (event.clientY - box.top) / box.height);
    area.style.setProperty("--tilt-x", tilt.x);
    area.style.setProperty("--tilt-y", tilt.y);
  });
  area.addEventListener("pointerleave", () => {
    area.style.removeProperty("--tilt-x");
    area.style.removeProperty("--tilt-y");
  });
}

if (matchMedia("(hover: hover)").matches && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
  if (stage) followPointer(stage);
}

/** The embedded apps: the windows on the stage, and the phone's. */
const lives = [];

/** The landing page's tone, to the embedded apps. */
function tellTone() {
  for (const live of lives) live.contentWindow?.postMessage({ type: "jackbird:tone", tone: root.dataset.theme === "dark" ? "dark" : "light" }, location.origin);
}

/** The app itself in `place`, over its screenshots, which stay shown until it has loaded (`live-on`). */
function embedApp(place, kind, title) {
  const live = document.createElement("iframe");
  live.className = "live";
  live.title = title;
  live.allow = "autoplay";
  live.src = `./demo/?embed${kind ? `=${kind}` : ""}&lang=en&tone=${root.dataset.theme === "dark" ? "dark" : "light"}`;
  live.addEventListener("load", () => place.classList.add("live-on"), { once: true });
  place.append(live);
  lives.push(live);
}

// On a computer the app itself takes the screenshots' place as the page loads: the windows on the
// stage, and the app as a phone draws it in the phone's picture. A phone keeps the screenshots.
if (matchMedia("(min-width: 901px)").matches) {
  if (stage) embedApp(stage, "", "jackbird, with the sample music");
  const handset = document.querySelector(".handset");
  if (handset) embedApp(handset, "phone", "jackbird on a phone, with the sample music");
}

// One of them at a time plays: the one that starts pauses the other.
window.addEventListener("message", (event) => {
  if (event.origin !== location.origin || event.data?.type !== "jackbird:playing") return;
  for (const live of lives) if (live.contentWindow !== event.source) live.contentWindow?.postMessage({ type: "jackbird:pause" }, location.origin);
});

// The embedded app asked for a folder: the demo is where one opens.
const invite = stage?.querySelector(".invite");
window.addEventListener("message", (event) => {
  if (event.origin !== location.origin || event.data?.type !== "jackbird:demo" || !invite) return;
  invite.hidden = false;
  invite.querySelector("a")?.focus();
});
invite?.querySelector("[data-close]")?.addEventListener("click", () => {
  invite.hidden = true;
});
