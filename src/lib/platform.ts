// Which runtime this is: the browser, or the desktop app (Tauri v2), whose
// webview sets `__TAURI_INTERNALS__` before any script runs. Decided once;
// src/lib/sources/ is the one place that acts on it. See
// RECORD/2026-08-11.musikmatch-rust-migration.WIP.md (E4-D1).

export const isDesktop: boolean = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
