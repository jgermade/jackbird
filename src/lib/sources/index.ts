// Where roots come from: the browser's folders, the desktop app's paths, or
// the paths of the machine jackbird's service runs on, whichever serves the
// page (./platform). The rest of the app only sees RootSource.
// See RECORD/2026-08-11.musikmatch-rust-migration.WIP.md (E4-D1).

import type { RootSource } from "../../types";
import { t } from "../i18n";
import { isDesktop, isService } from "../platform";
import { pickBrowserSource, restoreBrowserSource } from "./browser";

/** Asks for a folder to open: the browser's picker, the system's dialog, or the service's. Null when the person cancels. */
export async function pickSource(): Promise<RootSource | null> {
  if (isDesktop) {
    return (await import("./desktop")).pickDesktopSource();
  }
  if (await isService()) {
    const path = await (await import("../folders")).chooseMachineFolder();
    return path === null ? null : (await import("./service")).openServiceFolder(path);
  }
  return pickBrowserSource(t("message.noFsa"));
}

/** Reopens what the session kept of a root; null when it cannot be (no permission, a path gone, the other runtime's). */
export async function restoreSource(saved: FileSystemDirectoryHandle | string): Promise<RootSource | null> {
  if (typeof saved === "string") {
    if (isDesktop) {
      return (await import("./desktop")).restoreDesktopSource(saved);
    }
    return (await isService()) ? (await import("./service")).restoreServiceSource(saved) : null;
  }
  return isDesktop || (await isService()) ? null : restoreBrowserSource(saved);
}
