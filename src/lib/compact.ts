// The compact mode: the deck alone (views/compact.html), the display and the transport keys, while
// the library is out of the way. Where it shows depends on the runtime:
//
// - the desktop app: the window itself turns compact (no title bar, small, on top if asked, moved
//   by its chassis), and back to the place and size it had (C2);
// - a browser with Document Picture-in-Picture (Chromium's desktop browsers): the page stays as it
//   is, and the compact view floats in a window of its own (C1b);
// - any other browser: the page itself turns compact, for a narrow window.
//
// The desktop app keeps the mode, its place and "on top" across restarts (C3), and Ctrl+Shift+M
// (Cmd+Shift+M on macOS) turns it both ways. See RECORD/2026-11-03.deck-design-system.WIP.md
// (2026-11-13 06:30).

import { $reactive } from "jq79";
import { compactSize, isCompactShortcut, parseCompactState, pipSize, type Bounds, type CompactState } from "../helpers/compact";
import { isDesktop, isPhone } from "./platform";
import { readStored, STORAGE_KEYS, writeStored } from "./storage";

/** Where the compact view is: not shown, the window, a floating window, or the page. */
export type CompactMode = "full" | "window" | "pip" | "page";

/** Where the compact mode goes in this runtime. */
export type CompactPlace = "window" | "pip" | "page";

type PipWindow = Window & { document: Document };
type PipApi = { requestWindow(options: { width: number; height: number }): Promise<PipWindow>; window: PipWindow | null };

const pipApi = (): PipApi | null =>
  typeof window !== "undefined" && "documentPictureInPicture" in window ? ((window as unknown as { documentPictureInPicture: PipApi }).documentPictureInPicture ?? null) : null;

/** This runtime's place for the compact view. Phones have none: their screen is one deck already. */
export const compactPlace: CompactPlace | null = isPhone ? null : isDesktop ? "window" : pipApi() ? "pip" : "page";

export const compact = $reactive({
  mode: "full" as CompactMode,
  onTop: false,
  /** A turn under way: the keys wait for it. */
  busy: false
});

let saved: CompactState = parseCompactState(readStored(STORAGE_KEYS.compact));

function save(): void {
  writeStored(STORAGE_KEYS.compact, JSON.stringify(saved));
}

const rootPx = (): number => parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
const isMac = (): boolean => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** The shortcut, as the keys' titles print it. */
export const compactKeys: string = isMac() ? "⌘⇧M" : "Ctrl+Shift+M";

// ── The desktop app's window (C2) ─────────────────────────────────────────────

/** The full window's least size, as the desktop app makes it (src-tauri/src/lib.rs). */
const FULL_MIN = { width: 360, height: 480 };

const loadWindowApi = async () => {
  const [{ getCurrentWindow }, dpi] = await Promise.all([import("@tauri-apps/api/window"), import("@tauri-apps/api/dpi")]);
  return { win: getCurrentWindow(), ...dpi };
};
let windowModule: ReturnType<typeof loadWindowApi> | null = null;
/** Tauri's window API, loaded once (at the start in the desktop app, so a drag starts at once). */
const windowApi = () => (windowModule ??= loadWindowApi());

async function boundsOf(): Promise<Bounds> {
  const { win } = await windowApi();
  const [place, size] = await Promise.all([win.outerPosition(), win.innerSize()]);
  return { x: place.x, y: place.y, width: size.width, height: size.height };
}

/** Turns the window compact; `keepFull` is false at a start, when the full window's place is the saved one. */
async function windowCompact(keepFull: boolean): Promise<void> {
  const { win, LogicalSize, PhysicalPosition } = await windowApi();
  if (keepFull) {
    const maximized = await win.isMaximized();
    saved.full = { ...(await boundsOf()), maximized };
  }
  if (await win.isMaximized()) await win.unmaximize();
  const size = compactSize(rootPx());
  await win.setDecorations(false);
  await win.setMinSize(new LogicalSize(size.minWidth, size.minHeight));
  if (saved.compact) {
    await placeAndSize(saved.compact, saved.compact.width, saved.compact.height);
  } else {
    await win.setSize(new LogicalSize(size.width, size.height));
    // At the full window's top left (macOS sizes from the bottom: it would land where the bottom was).
    if (saved.full) await win.setPosition(new PhysicalPosition(saved.full.x, saved.full.y));
  }
  await win.setAlwaysOnTop(compact.onTop);
}

/**
 * Gives the window this inner size (in physical pixels) at `place`, and checks it held. On macOS a
 * title bar turned on is laid out later, asynchronously: a size set meanwhile is the bare frame's,
 * and when the bar comes it is taken out of the content (29 pixels short). And a window is sized
 * from its bottom edge there, so it is first moved down by what it will grow, to grow up into place
 * rather than past the screen's top. So: size, place, wait, read; and only when the inside is right
 * on two reads apart, done (up to four rounds, each waiting longer).
 */
async function placeAndSize(place: { x: number; y: number }, width: number, height: number): Promise<void> {
  const { win, PhysicalPosition, PhysicalSize } = await windowApi();
  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const right = async () => {
    const inner = await win.innerSize();
    return Math.abs(inner.width - width) <= 1 && Math.abs(inner.height - height) <= 1;
  };
  for (const wait of [100, 300, 600, 1000]) {
    if (isMac()) {
      const inner = await win.innerSize();
      await win.setPosition(new PhysicalPosition(place.x, place.y + Math.max(0, height - inner.height)));
    }
    await win.setSize(new PhysicalSize(width, height));
    await win.setPosition(new PhysicalPosition(place.x, place.y));
    await pause(wait);
    if (!(await right())) continue;
    await pause(300);
    if (await right()) return;
  }
}

async function windowFull(): Promise<void> {
  const { win, LogicalSize } = await windowApi();
  await win.setAlwaysOnTop(false);
  await win.setDecorations(true);
  await win.setMinSize(new LogicalSize(FULL_MIN.width, FULL_MIN.height));
  // The title bar comes asynchronously on macOS: give it a moment before sizing (placeAndSize checks after).
  await new Promise((resolve) => setTimeout(resolve, 200));
  const full = saved.full;
  if (full) {
    await placeAndSize(full, full.width, full.height);
    if (full.maximized) await win.maximize();
  } else {
    await win.setSize(new LogicalSize(1280, 800));
  }
}

/** While compact, the window's place and size are kept as the person moves and sizes it. */
async function followWindow(): Promise<void> {
  const { win } = await windowApi();
  let timer = 0;
  const keep = () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      if (compact.mode !== "window" || compact.busy) return;
      void boundsOf().then((bounds) => {
        saved.compact = bounds;
        save();
      });
    }, 400);
  };
  await win.onMoved(keep);
  await win.onResized(keep);
}

/** Starts moving the window, from a press on the compact deck's chassis (not on a key). */
export function dragWindow(event: PointerEvent): void {
  if (compact.mode !== "window" || event.button !== 0) return;
  const target = event.target as Element | null;
  if (target?.closest("button, a, input, select, textarea, [role='slider'], [role='meter'], [role='progressbar']")) return;
  event.preventDefault();
  void windowApi().then(({ win }) => win.startDragging());
}

/** Keeps the compact window on top of the others, or not. */
export async function setOnTop(on: boolean): Promise<void> {
  compact.onTop = on;
  saved.onTop = on;
  save();
  if (compact.mode === "window") {
    const { win } = await windowApi();
    await win.setAlwaysOnTop(on);
  }
}

// ── Picture-in-Picture (C1b) ──────────────────────────────────────────────────

/** The page element that holds the compact view while it floats (app.html's slot). */
const SLOT_ID = "compact-slot";

let floating: { pip: PipWindow; slot: HTMLElement; home: { parent: Node; next: Node | null }; stop: () => void } | null = null;

const waitFor = async (ready: () => boolean, tries = 40): Promise<boolean> => {
  for (let at = 0; at < tries && !ready(); at += 1) await new Promise((resolve) => setTimeout(resolve, 25));
  return ready();
};

/**
 * Copies the page's styles into the floating window, and keeps copying the ones that come later.
 * jq79 keeps its components' scoped styles in `document.adoptedStyleSheets`, constructed sheets
 * another document cannot adopt: their rules go over as text.
 */
function mirrorStyles(target: Document): () => void {
  const copied = new WeakSet<object>();
  const sync = () => {
    for (const node of Array.from(document.head.querySelectorAll("style, link[rel='stylesheet']"))) {
      if (copied.has(node)) continue;
      copied.add(node);
      target.head.append(node.cloneNode(true));
    }
    for (const sheet of document.adoptedStyleSheets ?? []) {
      if (copied.has(sheet)) continue;
      copied.add(sheet);
      const style = target.createElement("style");
      style.textContent = Array.from(sheet.cssRules, (rule) => rule.cssText).join("\n");
      target.head.append(style);
    }
    const root = document.documentElement;
    const theirs = target.documentElement;
    for (const name of ["data-theme", "lang"]) {
      const value = root.getAttribute(name);
      if (value !== null && theirs.getAttribute(name) !== value) theirs.setAttribute(name, value);
    }
  };
  sync();
  const timer = window.setInterval(sync, 500);
  return () => window.clearInterval(timer);
}

async function floatOpen(): Promise<void> {
  const api = pipApi();
  if (!api) return;
  const pip = await api.requestWindow(pipSize(rootPx()));
  compact.mode = "pip";
  const slot = document.getElementById(SLOT_ID);
  if (!slot || !(await waitFor(() => slot.childElementCount > 0))) {
    compact.mode = "full";
    pip.close();
    return;
  }
  const home = { parent: slot.parentNode as Node, next: slot.nextSibling };
  pip.document.title = document.title;
  const stopStyles = mirrorStyles(pip.document);
  pip.document.body.style.margin = "0";
  pip.document.body.append(slot);
  slot.hidden = false;
  const onKey = (event: KeyboardEvent) => onShortcut(event);
  pip.document.addEventListener("keydown", onKey);
  floating = {
    pip,
    slot,
    home,
    stop: () => {
      stopStyles();
      pip.document.removeEventListener("keydown", onKey);
    }
  };
  pip.addEventListener("pagehide", () => floatClosed(), { once: true });
}

/** The floating window closed (by its own ×, or from the view's key): the view goes home. */
function floatClosed(): void {
  if (!floating) return;
  const { slot, home, stop } = floating;
  floating = null;
  stop();
  slot.hidden = true;
  home.parent.insertBefore(slot, home.next && home.next.parentNode === home.parent ? home.next : null);
  compact.mode = "full";
}

// ── Turning it ────────────────────────────────────────────────────────────────

async function turn(work: () => Promise<void>): Promise<void> {
  if (compact.busy) return;
  compact.busy = true;
  try {
    await work();
  } catch (error) {
    console.error("compact mode:", error);
  } finally {
    compact.busy = false;
  }
}

/** Turns the compact mode on, in this runtime's place. */
export function enterCompact(): Promise<void> {
  return turn(async () => {
    if (compact.mode !== "full" || !compactPlace) return;
    if (compactPlace === "window") {
      await windowCompact(true);
      compact.mode = "window";
      saved.on = true;
      save();
    } else if (compactPlace === "pip") {
      // Its first step asks for the window, still within the click's activation.
      await floatOpen();
    } else {
      compact.mode = "page";
    }
  });
}

/** Back to the full view. */
export function leaveCompact(): Promise<void> {
  return turn(async () => {
    if (compact.mode === "window") {
      saved.compact = await boundsOf();
      saved.on = false;
      save();
      await windowFull();
    } else if (compact.mode === "pip") {
      floating?.pip.close();
      floatClosed();
      return;
    }
    compact.mode = "full";
  });
}

export function toggleCompact(): Promise<void> {
  return compact.mode === "full" ? enterCompact() : leaveCompact();
}

function onShortcut(event: KeyboardEvent): void {
  if (!compactPlace || event.repeat || !isCompactShortcut(event, isMac())) return;
  event.preventDefault();
  void toggleCompact();
}

/**
 * At the start: the shortcut, and in the desktop app the mode it was closed in (the window opens
 * at its full size and turns compact in its first frames), and the following of its place.
 */
export function startCompact(): void {
  if (!compactPlace) return;
  compact.onTop = saved.onTop;
  document.addEventListener("keydown", onShortcut);
  if (compactPlace !== "window") return;
  void followWindow().catch(() => undefined);
  if (saved.on) {
    void turn(async () => {
      await windowCompact(false);
      compact.mode = "window";
    });
  }
}

