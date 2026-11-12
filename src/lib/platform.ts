// Which runtime this is: the browser, or the desktop app (Tauri v2), whose
// webview sets `__TAURI_INTERNALS__` before any script runs. Decided once;
// src/lib/sources/ is the one place that acts on it. See
// RECORD/2026-08-11.musikmatch-rust-migration.WIP.md (E4-D1).

export const isDesktop: boolean = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/**
 * Whether the app runs on a phone (Tauri's Android or iOS build, E6's spike): then it is a client
 * of a family instance, by its address, and has no folders, service or native output of its own.
 */
export const isPhone: boolean = isDesktop && typeof navigator !== "undefined" && /Android|iPhone|iPad|iPod/.test(navigator.userAgent);

/**
 * Whether the page is the app embedded in the landing page (`?embed`, in an iframe of it): the
 * sample music opened at once, its window and its compact player drawn together over one player,
 * no session kept, the tone the landing page's. See RECORD/2026-11-03.deck-design-system.WIP.md
 * (2026-11-13 20:30).
 */
export const isEmbed: boolean = !isDesktop && typeof location !== "undefined" && new URLSearchParams(location.search).has("embed");

/**
 * How the embedded app is drawn: "windows", its window and its compact player (`?embed`), or
 * "phone", the app alone filling the frame as a phone draws it (`?embed=phone`, the landing page's
 * phone); null when not embedded.
 */
export const embedKind: "windows" | "phone" | null = isEmbed ? (new URLSearchParams(location.search).get("embed") === "phone" ? "phone" : "windows") : null;

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
