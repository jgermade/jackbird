// The tab's icon: the logo as the display shows it (its shape lit in the display's ink on the
// display's glass: dark on the olive LCD in Silver, glowing aqua on the black VFD in Graphite),
// drawn again whenever the tone changes, so the tab always carries the display in use.

import logoUrl from "../assets/brand/jackbird-metal.svg?url";
import { preferences } from "./preferences";

const SIZE = 64;

function loadLogo(): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = logoUrl;
  });
}

function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function iconLink(): HTMLLinkElement {
  const found = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (found) return found;
  const link = document.createElement("link");
  link.rel = "icon";
  document.head.append(link);
  return link;
}

function draw(logo: HTMLImageElement): string {
  const ground = token("--mm-display-bg");
  const ink = token("--mm-display-fg");
  const glows = token("--mm-display-glow") !== "none";

  // The logo's shape, filled with the display's ink.
  const shape = document.createElement("canvas");
  shape.width = shape.height = SIZE;
  const s = shape.getContext("2d")!;
  const inset = SIZE * 0.14;
  const box = SIZE - inset * 2;
  const scale = Math.min(box / logo.naturalWidth, box / logo.naturalHeight);
  const w = logo.naturalWidth * scale;
  const h = logo.naturalHeight * scale;
  s.drawImage(logo, (SIZE - w) / 2, (SIZE - h) / 2, w, h);
  s.globalCompositeOperation = "source-in";
  s.fillStyle = ink;
  s.fillRect(0, 0, SIZE, SIZE);

  // The glass, then the shape on it (glowing on a VFD).
  const icon = document.createElement("canvas");
  icon.width = icon.height = SIZE;
  const c = icon.getContext("2d")!;
  c.fillStyle = ground;
  c.beginPath();
  c.roundRect(0, 0, SIZE, SIZE, SIZE * 0.2);
  c.fill();
  if (glows) {
    c.shadowColor = ink;
    c.shadowBlur = SIZE * 0.08;
  }
  c.drawImage(shape, 0, 0);
  return icon.toDataURL("image/png");
}

/** Keeps the tab's icon in the display's colours, from now on. */
export function keepFaviconLit(): void {
  void loadLogo().then((logo) => {
    const link = iconLink();
    const update = (): void => {
      link.type = "image/png";
      link.href = draw(logo);
    };
    update();
    preferences.$onAny(update);
  });
}
