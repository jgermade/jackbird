// Where roots come from: the browser's folders, the desktop app's paths, or
// the paths of the machine jackbird's service runs on, whichever serves the
// page (./platform). The rest of the app only sees RootSource.
// See RECORD/2026-08-11.musikmatch-rust-migration.WIP.md (E4-D1).

import type { RootSource } from "../../types";
import { t } from "../i18n";
import { isDesktop, isPhone, isService } from "../platform";
import { parseSaved } from "../../helpers/instance";
import { pickBrowserSource, restoreBrowserSource } from "./browser";
import type { ServiceClient } from "./service";

/**
 * Asks for a folder to open: the browser's picker, the system's dialog, or the service's; with
 * `server`, a folder of that server's machine (E6b-D11). Null when the person cancels.
 */
export async function pickSource(server?: ServiceClient): Promise<RootSource | null> {
  // The phone's own folders (E6b-D9): once "All files access" is granted, by their paths, as on a computer.
  if (isPhone && !server) {
    const { deviceFolders, ensureStorageAccess } = await import("../device-storage");
    if (!(await ensureStorageAccess())) throw new Error(t("sources.storageDenied"));
    const path = await (await import("../folders")).chooseMachineFolder(deviceFolders);
    return path === null ? null : (await import("./desktop")).restoreDesktopSource(path);
  }
  if (server) {
    const path = await (await import("../folders")).chooseMachineFolder();
    return path === null ? null : (await import("./service")).openServiceFolder(path, server);
  }
  // A phone has no folder dialog: the instance's own folder chooser, as on the web (E6's spike).
  if (isPhone && (await (await import("../desktop-service")).desktopUsesService())) {
    const path = await (await import("../folders")).chooseMachineFolder();
    return path === null ? null : (await import("./service")).openServiceFolder(path);
  }
  if (isDesktop) {
    if (await (await import("../desktop-service")).desktopUsesService()) {
      // The app is the installed service's interface (S2): the system's dialog, the service opens it.
      const { invoke } = await import("@tauri-apps/api/core");
      const path = await invoke<string | null>("choose_folder");
      return path === null ? null : (await import("./service")).openServiceFolder(path);
    }
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
  // A root of a server other than the home one (E6b-D11), kept with its address.
  const onServer = typeof saved === "string" ? parseSaved(saved) : null;
  if (onServer?.server) {
    const service = await import("./service");
    return service.restoreServiceSource(onServer.path, service.serviceAt(onServer.server));
  }
  if (typeof saved === "string") {
    if (isDesktop) {
      return (await (await import("../desktop-service")).desktopUsesService())
        ? (await import("./service")).restoreServiceSource(saved)
        : (await import("./desktop")).restoreDesktopSource(saved);
    }
    return (await isService()) ? (await import("./service")).restoreServiceSource(saved) : null;
  }
  return isDesktop || (await isService()) ? null : restoreBrowserSource(saved);
}
