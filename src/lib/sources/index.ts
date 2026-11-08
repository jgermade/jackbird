// Where roots come from: the browser's folders or the desktop app's paths,
// whichever runs (./platform). The rest of the app only sees RootSource.
// See RECORD/2026-08-11.musikmatch-rust-migration.WIP.md (E4-D1).

import type { RootSource } from "../../types";
import { t } from "../i18n";
import { isDesktop } from "../platform";
import { pickBrowserSource, restoreBrowserSource } from "./browser";

/** Asks for a folder to open: the browser's picker, or the system's dialog. Null when the person cancels. */
export async function pickSource(): Promise<RootSource | null> {
  if (isDesktop) {
    return (await import("./desktop")).pickDesktopSource();
  }
  return pickBrowserSource(t("message.noFsa"));
}

/** Reopens what the session kept of a root; null when it cannot be (no permission, a path gone, the other runtime's). */
export async function restoreSource(saved: FileSystemDirectoryHandle | string): Promise<RootSource | null> {
  if (typeof saved === "string") {
    return isDesktop ? (await import("./desktop")).restoreDesktopSource(saved) : null;
  }
  return isDesktop ? null : restoreBrowserSource(saved);
}
