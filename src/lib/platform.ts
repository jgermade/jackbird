// Which runtime this is: the browser, or the desktop app (Tauri v2), whose
// webview sets `__TAURI_INTERNALS__` before any script runs. Decided once;
// src/lib/sources/ is the one place that acts on it. See
// RECORD/2026-08-11.musikmatch-rust-migration.WIP.md (E4-D1).

export const isDesktop: boolean = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

let served: Promise<boolean> | null = null;

/**
 * Whether the page is served by jackbird's service (S1), which answers
 * `/api/info` on the page's own origin; asked once. Never in the desktop app.
 */
export function isService(): Promise<boolean> {
  served ??= isDesktop
    ? Promise.resolve(false)
    : fetch("/api/info")
        .then((response) => (response.ok ? response.json() : null))
        .then((info: { name?: string } | null) => info?.name === "jackbird-service")
        .catch(() => false);
  return served;
}
