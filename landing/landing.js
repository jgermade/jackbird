// The landing's few moving parts: the tone switch (Silver / Graphite, remembered), the display's
// spectrum dancing, and the tab's icon lit like the display, as in the app (src/lib/favicon.ts).

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

// ---- the spectrum -------------------------------------------------------------------------

const spectrum = document.querySelector(".spectrum");
const BANDS = 24;
const bars = Array.from({ length: BANDS }, () => spectrum.appendChild(document.createElement("i")));
const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
let t = 0;

function dance() {
  t += 1;
  bars.forEach((bar, i) => {
    // Louder in the low bands, a beat every so often, and some noise.
    const tilt = 1 - i / BANDS * .55;
    const beat = Math.max(0, Math.sin(t / 3.2)) ** 6 * .35;
    const wave = (Math.sin(t / 5 + i * .7) + 1) / 2 * .45;
    const level = Math.min(1, Math.max(.06, (wave + beat + Math.random() * .25) * tilt));
    bar.style.setProperty("--level", level.toFixed(3));
  });
}
if (still) {
  bars.forEach((bar, i) => bar.style.setProperty("--level", (.75 - i / BANDS * .5).toFixed(3)));
} else {
  dance();
  setInterval(dance, 110);
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
