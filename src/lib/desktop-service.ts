// The service, seen from the desktop app (S2, RECORD/2026-08-11.musikmatch-
// rust-migration.WIP.md, 18:42 as amended at 18:57): whether it is installed
// (and how), started, and newer than the installed one; installing, updating,
// starting and uninstalling it through the app's commands
// (src-tauri/src/service.rs). While it is installed the app is only its
// interface: its roots are the service's (./sources/service), and a stopped
// service is started rather than left for the app's own backend (one writer
// at a time). Installing or uninstalling reloads the window, so every root
// is opened again by the backend that now holds it.

import { invoke } from "@tauri-apps/api/core";
import { $reactive } from "jq79";
import { isNewerVersion } from "../helpers/version";
import { t } from "./i18n";
import { library } from "./library";
import { isPhone } from "./platform";
import { useServiceAt } from "./sources/service";

export type ServiceStatus = {
  installed: "logon" | "system" | null;
  running: boolean;
  version: string | null;
  port: number;
  /** The version of the app's own copy. */
  binaryVersion: string;
};

export const serviceState = $reactive({
  status: null as ServiceStatus | null,
  busy: false,
  error: "",
  /** Whether the app's copy is newer than the installed service. */
  updateAvailable: false
});

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function status(): Promise<ServiceStatus | null> {
  const found = await invoke<ServiceStatus>("service_status").catch(() => null);
  serviceState.status = found;
  serviceState.updateAvailable = Boolean(found?.installed && isNewerVersion(found.binaryVersion, found.version));
  return found;
}

let usesService: Promise<boolean> | null = null;

/**
 * Whether the installed service is the app's backend: then it is started if
 * it is stopped, its address is where `service.ts` asks, and an update is
 * announced. Asked once per window.
 */
export function desktopUsesService(): Promise<boolean> {
  // A phone has no service of its own, nor a home server: servers are sources it adds (E6b-D11).
  if (isPhone) return Promise.resolve(false);
  usesService ??= (async () => {
    let found = await status();
    if (!found?.installed) {
      return false;
    }
    if (!found.running) {
      await invoke("service_start").catch(() => undefined);
      for (let step = 0; step < 16 && !found?.running; step += 1) {
        await wait(500);
        found = await status();
      }
      if (!found?.running) {
        library.errorMessage = t("service.notAnswering");
      }
    }
    useServiceAt(`http://127.0.0.1:${found?.port ?? 4646}`);
    if (serviceState.updateAvailable) {
      library.infoMessage = t("service.updateAvailable");
    }
    return true;
  })();
  return usesService;
}

/** Runs one of the app's service commands, then reloads the window when it changed the backend. */
async function act(command: string, args: Record<string, unknown> = {}, reload = true): Promise<void> {
  serviceState.busy = true;
  serviceState.error = "";
  try {
    await invoke(command, args);
    if (reload) {
      location.reload();
      return;
    }
    await status();
  } catch (error) {
    const failure = error as { message?: string };
    serviceState.error = failure.message ?? String(error);
  } finally {
    serviceState.busy = false;
  }
}

export const refreshServiceStatus = (): Promise<unknown> => status();
export const installService = (withSystem: boolean, password?: string): Promise<void> =>
  act("service_install", { withSystem, password: password || null });
export const uninstallService = (): Promise<void> => act("service_uninstall");
export const updateService = (): Promise<void> => act("service_update", {}, true);
export const startService = (): Promise<void> => act("service_start", {}, true);
