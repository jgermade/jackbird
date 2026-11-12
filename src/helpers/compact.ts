/**
 * The compact mode's pure parts: its sizes (in rem, turned to the window's pixels by the root's
 * font size), the state kept across restarts, and its shortcut. See
 * RECORD/2026-11-03.deck-design-system.WIP.md (2026-11-13 06:30).
 */

/** The compact window's size, and the least it can be made, in rem. */
export const COMPACT = { width: 34, height: 7, minWidth: 20, minHeight: 6, pipHeight: 8.75 } as const;

/** A window's place and its whole size (title bar and all), in physical pixels, as the desktop app reports them. */
export type Bounds = { x: number; y: number; width: number; height: number };

/** What is kept across restarts. */
export type CompactState = {
  /** Whether the app was compact when it closed. */
  on: boolean;
  /** Whether the compact window is kept on top of the others. */
  onTop: boolean;
  /** The compact window's last place and size, once it was moved or sized. */
  compact: Bounds | null;
  /** The full window's place and size before it turned compact. */
  full: (Bounds & { maximized: boolean }) | null;
};

export const NO_COMPACT: CompactState = { on: false, onTop: false, compact: null, full: null };

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

/** The floating window's size (Picture-in-Picture), in pixels: as wide, a little taller for the next track. */
export function pipSize(rootPx: number): { width: number; height: number } {
  return { width: remToPx(COMPACT.width, rootPx), height: remToPx(COMPACT.pipHeight, rootPx) };
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
    onTop: saved.onTop === true,
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
