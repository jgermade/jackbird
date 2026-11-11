// "Add to the library…" (E6b-D11): which source the music comes from, then that source's own
// steps. A folder of this device (the browser's picker, the system's dialog, or, on a phone, its
// own folders), a folder of the server spoken to now (its owners), or a jackbird server by its
// address, whose family library and open folders join the library. The view is
// views/sources-dialog.html. See RECORD/2026-08-11.musikmatch-rust-migration.WIP.md (2026-11-11 22:47).

import { $reactive, $toRaw } from "jq79";
import { normaliseAddress } from "../helpers/instance";
import { account, can, followServer, whenSignedIn } from "./account";
import { t } from "./i18n";
import { importing } from "./importing";
import { library } from "./library";
import { isDesktop, isPhone, isService } from "./platform";
import { hydrateRoot, openFolder } from "./roots";
import { currentServer, homeServer, serviceAt, serviceRoots } from "./sources/service";

export type SourceKind = "device" | "serverFolder" | "server";

export const adding = $reactive({
  open: false,
  /** Choosing the source, or typing a server's address. */
  step: "choose" as "choose" | "server",
  address: "",
  busy: false,
  error: "",
  /** Whether a service serves the page (asked once): then its folders are the server's, not the device's. */
  served: null as boolean | null
});

void isService().then((answer) => (adding.served = answer));

/** The server spoken to now, as the person reads it: its address, or "this server" for the page's own. */
export function serverName(): string {
  return currentServer().address.replace(/^https?:\/\//, "") || t("sources.thisServer");
}

/** The sources this runtime offers now, in order. */
export function sourcesHere(): SourceKind[] {
  const kinds: SourceKind[] = [];
  // The browser's folders when no service serves the page; the desktop's; a phone's in E6b's step 3.3.
  if ((isDesktop && !isPhone) || (!isDesktop && adding.served === false)) kinds.push("device");
  // A folder of the server in front, for its owners: the page's own server, or one the app added
  // (the desktop's installed service is its "device" already).
  const server = currentServer();
  const pageServer = !isDesktop && server === homeServer();
  if (account.active && can("owner") && (pageServer || server !== homeServer() || isPhone)) kinds.push("serverFolder");
  // A server by its address: the apps only (a page from a static host would need the server's CORS).
  if (isDesktop) kinds.push("server");
  return kinds;
}

/** "Add to the library…": straight to the only source there is, else the choice. */
export function openAdding(): void {
  const kinds = sourcesHere();
  if (kinds.length === 1 && kinds[0] !== "server") {
    void addFrom(kinds[0]);
    return;
  }
  adding.open = true;
  adding.step = kinds.length === 1 ? "server" : "choose";
  adding.error = "";
}

export function closeAdding(): void {
  if (!adding.busy) adding.open = false;
}

/** Back from the address to the choice. */
export function backToChoice(): void {
  adding.step = "choose";
  adding.error = "";
}

/** Adds from a source: a folder at once (its dialog), or the server's address next. */
export async function addFrom(kind: SourceKind): Promise<void> {
  if (kind === "server") {
    adding.open = true;
    adding.step = "server";
    adding.error = "";
    return;
  }
  adding.open = false;
  // A folder of this device or of the server in front: lib/sources picks the right dialog.
  await openFolder(kind === "serverFolder" ? currentServer() : undefined);
}

/**
 * Connects to a server by the address typed: it must answer as jackbird's service. Then signs in
 * there if it asks, and opens its family library and the folders its owners opened, the first in
 * front.
 */
export async function addServer(typed: string): Promise<void> {
  const address = normaliseAddress(typed);
  if (!address) {
    adding.error = t("instance.notAddress");
    return;
  }
  adding.busy = true;
  adding.error = "";
  try {
    const info = await fetch(`${address}/api/info`)
      .then((response) => (response.ok ? response.json() : null))
      .catch(() => {
        throw new Error(t("instance.unreachable", { address }));
      });
    if ((info as { name?: string } | null)?.name !== "jackbird-service") throw new Error(t("instance.notJackbird", { address }));
    const client = serviceAt(address);
    adding.open = false;
    await followServer(client);
    if (!account.me && !(await whenSignedIn())) return;
    const open = new Set($toRaw(library).roots.map((root) => root.source.saved));
    let first: string | null = null;
    for (const source of await serviceRoots(client)) {
      if (open.has(source.saved)) continue;
      await hydrateRoot(source, { setActive: first === null });
      first ??= $toRaw(library).activeRootId;
    }
    importing.available = $toRaw(library).roots.some((root) => root.source.kind === "library" && root.source.server === currentServer());
    if (first === null) library.infoMessage = t("sources.nothingOpen", { server: serverName() });
  } catch (error) {
    adding.open = true;
    adding.error = error instanceof Error ? error.message : String(error);
  } finally {
    adding.busy = false;
  }
}
