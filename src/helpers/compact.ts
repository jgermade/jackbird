/**
 * The compact mode's pure parts: its sizes (in rem, turned to the window's pixels by the root's
 * font size), the state kept across restarts, and its shortcut. See
 * RECORD/2026-11-03.deck-design-system.WIP.md (2026-11-13 06:30).
 */

/** The compact window's size, and the least it can be made, in rem: a card, the display over the keys. */
export const COMPACT = { width: 22, height: 11, minWidth: 18, minHeight: 10, list: 14 } as const;

/**
 * The root's size in the compact player, as a share of the window's width (tokens.css:
 * `--mm-root-compact`'s 4.5vw). With the queue's list open the root follows the width alone, so
 * the card keeps its size and the list takes what the window grows by.
 */
export const COMPACT_ROOT_VW = 0.045;

/**
 * The compact window's height for its width, with the queue's list or without: the card's 11rem
 * (and the list's 14rem), at the root that width gives. In the same unit as the width.
 */
export function compactHeightFor(width: number, list: boolean): number {
  if (!Number.isFinite(width) || width <= 0) return 0;
  const root = width * COMPACT_ROOT_VW;
  return Math.round((COMPACT.height + (list ? COMPACT.list : 0)) * root);
}

/** A window's place and its whole size (title bar and all), in physical pixels, as the desktop app reports them. */
export type Bounds = { x: number; y: number; width: number; height: number };

/** What is kept across restarts. */
export type CompactState = {
  /** Whether the app was compact when it closed. */
  on: boolean;
  /** Whether the compact window is kept on top of the others: so by default, until turned off. */
  onTop: boolean;
  /** Whether the compact player shows the queue's list. */
  list: boolean;
  /** The compact window's last place and size, once it was moved or sized. */
  compact: Bounds | null;
  /** The full window's place and size before it turned compact. */
  full: (Bounds & { maximized: boolean }) | null;
};

export const NO_COMPACT: CompactState = { on: false, onTop: true, list: false, compact: null, full: null };

/** A size in rem, in pixels at the given root font size (in px), rounded. */
export function remToPx(rem: number, rootPx: number): number {
  const root = Number.isFinite(rootPx) && rootPx > 0 ? rootPx : 16;
  return Math.round(rem * root);
}

/** The compact window's size and least size, in pixels at the given root font size. */
export function compactSize(rootPx: number): { width: number; height: number; minWidth: number; minHeight: number } {
  return {
    width: remToPx(COMPACT.width, rootPx),
    height: remToPx(COMPACT.height, rootPx),
    minWidth: remToPx(COMPACT.minWidth, rootPx),
    minHeight: remToPx(COMPACT.minHeight, rootPx)
  };
}

/** The floating window's size (Picture-in-Picture), in pixels: the compact window's. */
export function pipSize(rootPx: number): { width: number; height: number } {
  return { width: remToPx(COMPACT.width, rootPx), height: remToPx(COMPACT.height, rootPx) };
}

function bounds(value: unknown): Bounds | null {
  if (!value || typeof value !== "object") return null;
  const { x, y, width, height } = value as Record<string, unknown>;
  const numbers = [x, y, width, height];
  if (!numbers.every((one) => typeof one === "number" && Number.isFinite(one))) return null;
  if ((width as number) <= 0 || (height as number) <= 0) return null;
  return { x: Math.round(x as number), y: Math.round(y as number), width: Math.round(width as number), height: Math.round(height as number) };
}

/** The state read back from storage; anything missing or malformed takes its default. */
export function parseCompactState(raw: string | null): CompactState {
  if (!raw) return { ...NO_COMPACT };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ...NO_COMPACT };
  }
  if (!value || typeof value !== "object") return { ...NO_COMPACT };
  const saved = value as Record<string, unknown>;
  const full = bounds(saved.full);
  return {
    on: saved.on === true,
    onTop: saved.onTop !== false,
    list: saved.list === true,
    compact: bounds(saved.compact),
    full: full ? { ...full, maximized: (saved.full as Record<string, unknown>).maximized === true } : null
  };
}

/** The key event's parts the shortcut looks at. */
export type KeyParts = { key: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean };

/** Whether a key press is the compact mode's shortcut: Ctrl+Shift+M, or Cmd+Shift+M on macOS. */
export function isCompactShortcut(event: KeyParts, mac: boolean): boolean {
  if (event.key.toLowerCase() !== "m" || !event.shiftKey || event.altKey) return false;
  return mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}
