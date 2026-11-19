// Updating the server spoken to now from the app (owners; Preferences, Server): its version, the
// latest release's, whether it can update itself, and the update, then waiting for it to answer
// with the new version. The service's side is crates/service/src/update.rs. See
// RECORD/2026-11-03.deck-design-system.WIP.md (2026-11-19, updating the server from the app).

import { $reactive } from "jq79";
import { t } from "./i18n";
import { currentServer, post, serviceJson } from "./sources/service";

/** Whether the server can update itself, and if not, why. */
export type UpdateWay = "yes" | "container" | "system" | "manual" | "readonly";

type UpdateState = { version: string; latest: string | null; newer: boolean; can: UpdateWay; error?: string };

export const serverUpdate = $reactive({
  loaded: false,
  version: "",
  /** The latest release's version (empty while not known). */
  latest: "",
  newer: false,
  can: "" as UpdateWay | "",
  error: "",
  busy: false,
  /** The version it was just updated to. */
  done: ""
});

/** How long the server may take to come back with the new version (Windows' Task Scheduler waits a minute). */
const BACK_WITHIN = 180_000;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Asks the server what it runs and what it could run. */
export async function loadServerUpdate(): Promise<void> {
  serverUpdate.error = "";
  try {
    const state = await serviceJson<UpdateState>("update");
    serverUpdate.version = state.version;
    serverUpdate.latest = state.latest ?? "";
    serverUpdate.newer = state.newer;
    serverUpdate.can = state.can;
    serverUpdate.error = state.error ?? "";
  } catch (error) {
    serverUpdate.error = message(error);
  } finally {
    serverUpdate.loaded = true;
  }
}

/** Updates the server, then waits for it to answer again with the new version. */
export async function updateServer(): Promise<void> {
  serverUpdate.busy = true;
  serverUpdate.error = "";
  serverUpdate.done = "";
  try {
    const { version } = await serviceJson<{ version: string }>("update", post());
    const until = Date.now() + BACK_WITHIN;
    while (Date.now() < until) {
      await wait(2000);
      const info = await fetch(`${currentServer().address}/api/info`)
        .then((response) => (response.ok ? (response.json() as Promise<{ version?: string }>) : null))
        .catch(() => null);
      if (info?.version === version) {
        serverUpdate.version = version;
        serverUpdate.newer = false;
        serverUpdate.done = version;
        return;
      }
    }
    serverUpdate.error = t("server.updateLate");
  } catch (error) {
    serverUpdate.error = message(error);
  } finally {
    serverUpdate.busy = false;
  }
}
