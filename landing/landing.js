// The landing's few moving parts: the tone switch (Silver / Graphite, remembered; the page's
// screenshots follow it) and the tab's icon lit like the display, as in the app (src/lib/favicon.ts).

const root = document.documentElement;
const KEY = "jackbird-landing-tone";

// ---- the tone -----------------------------------------------------------------------------

const toneKey = document.querySelector(".tone");
const toneName = document.querySelector(".tone-name");

function showTone() {
  // The key names the tone it switches to.
  toneName.textContent = root.dataset.theme === "dark" ? "Silver" : "Graphite";
  drawFavicon();
}

toneKey.addEventListener("click", () => {
  root.dataset.theme = root.dataset.theme === "dark" ? "light" : "dark";
  try { localStorage.setItem(KEY, root.dataset.theme); } catch {}
  showTone();
});

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

// The system's tone, followed until one is chosen here.
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (event) => {
  let saved = null;
  try { saved = localStorage.getItem(KEY); } catch {}
  if (!saved) {
    root.dataset.theme = event.matches ? "dark" : "light";
    showTone();
  }
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

// This device's first: its first download (an AppImage before a .deb), the whole first row.
const system = thisSystem();
const downloads = document.querySelector(".downloads");
const mine = system && downloads?.querySelector(`.download[data-os="${system}"]`);
if (mine) {
  mine.classList.add("mine");
  mine.dataset.action = "Download";
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
      if (link === mine) mine.dataset.action = `Download · ${megabytes(asset.size)}`;
    }
    const version = document.querySelector(".release");
    if (version && release.tag_name) version.textContent = `jackbird ${release.tag_name}.`;
  })
  .catch(() => {});
