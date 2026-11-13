// "Add to the library…" (E6b-D11): which source the music comes from, then that source's own
// steps. A folder of this device (the browser's picker, the system's dialog, or, on a phone, its
// own folders), a folder of the server spoken to now (its owners), or a jackbird server by its
// address, whose family library and open folders join the library. The view is
// views/sources-dialog.html. See RECORD/2026-08-11.musikmatch-rust-migration.WIP.md (2026-11-11 22:47).

import { $reactive, $toRaw } from "jq79";
import { normaliseAddress } from "../helpers/instance";
import type { FolderAccess } from "../helpers/picked";
import type { SampleList } from "../helpers/samples";
import { account, can, followServer, whenSignedIn } from "./account";
import { t } from "./i18n";
import { importing } from "./importing";
import { library } from "./library";
import { isDesktop, isEmbed, isPhone, isService } from "./platform";
import { recent, forgetRecent, type RecentRoot } from "./recent";
import { hydrateRoot, openFolder, openSamples } from "./roots";
import { restoreSource } from "./sources";
import { folderAccessHere } from "./sources/picked";
import { currentServer, homeServer, librarySource, serviceAt, serviceRoots, sharedShelves, type Shelf } from "./sources/service";

export type SourceKind = "device" | "serverFolder" | "server";

export const adding = $reactive({
  open: false,
  /** The dialog's tab: a folder (of this device, or of the server in front), or a server by its address. */
  tab: "folder" as "folder" | "server",
  address: "",
  busy: false,
  error: "",
  /** Whether a service serves the page (asked once): then its folders are the server's, not the device's. */
  served: null as boolean | null,
  /** The demo's sample music, where the page has some beside it (GitHub Pages, the dev server). */
  samples: null as SampleList | null,
  /** The music shared with one on the server in front (SH-D6), each to open as a tab. */
  shared: [] as Shelf[]
});

/** Asks the server in front for the music shared with one (none without a server or a session). */
export async function loadShared(): Promise<void> {
  adding.shared = account.active ? await sharedShelves().catch(() => []) : [];
}

/** A shared music's tab: "Ana's music". */
export const sharedLabel = (name: string): string => t("sources.sharedBy", { name });

/** Opens someone's music shared with one as a tab of its own, or shows it if it is open. */
export async function openShared(shelf: Shelf): Promise<void> {
  adding.open = false;
  const server = currentServer();
  const open = $toRaw(library).roots.find((root) => root.source.kind === "library" && root.source.server === server && root.source.shelf === shelf.shelf);
  if (open) {
    library.activeRootId = open.id;
    return;
  }
  const source = await librarySource(server, shelf);
  if (!source) {
    library.errorMessage = t("sources.noLongerShared", { name: shelf.name });
    return;
  }
  await hydrateRoot(source, { setActive: true, rootLabel: sharedLabel(shelf.name) });
}

void isService().then((answer) => {
  adding.served = answer;
  // In the browser, with no service: the sample music, if any is served beside the app.
  if (!answer && !isDesktop) void import("./sources/samples").then((samples) => samples.sampleList()).then((list) => (adding.samples = list));
});

/** Opens the sample music, closing the dialog. */
export function addSamples(): void {
  if (!adding.samples) return;
  adding.open = false;
  void openSamples(adding.samples);
}

/** The server spoken to now, as the person reads it: its address, or "this server" for the page's own. */
export function serverName(): string {
  return currentServer().address.replace(/^https?:\/\//, "") || t("sources.thisServer");
}

/** The sources this runtime offers now, in order. */
export function sourcesHere(): SourceKind[] {
  const kinds: SourceKind[] = [];
  // The browser's folders when no service serves the page; the desktop's; an Android phone's, through
  // its own folder picker, which grants the app that folder alone (E6b-D9, 2026-11-12).
  const android = isPhone && /Android/.test(navigator.userAgent);
  if ((isDesktop && (!isPhone || android)) || (!isDesktop && adding.served === false)) kinds.push("device");
  // A folder of the server in front, for its owners: the page's own server, or one the app added
  // (the desktop's installed service is its "device" already).
  const server = currentServer();
  const pageServer = !isDesktop && server === homeServer();
  if (account.active && can("owner") && (pageServer || server !== homeServer() || isPhone)) kinds.push("serverFolder");
  // A server by its address: the apps only (a page from a static host would need the server's CORS).
  if (isDesktop) kinds.push("server");
  return kinds;
}

/** The folders this runtime offers now (the "Folder" tab's choices). */
export const folderSources = (): SourceKind[] => sourcesHere().filter((kind) => kind !== "server");

/**
 * What a folder of this device can be here: read and written (the apps, a Chromium browser), only
 * read (Safari, Firefox: lib/sources/picked.ts), or not opened at all (a browser with neither).
 */
export const deviceAccess = (): FolderAccess => (isDesktop ? "full" : folderAccessHere());

/** The dialog's tabs: "Folder" wherever folders are offered; "Server" in the apps. */
export function tabsHere(): ("folder" | "server")[] {
  const tabs: ("folder" | "server")[] = [];
  if (folderSources().length > 0 || recent.list.length > 0 || adding.shared.length > 0) tabs.push("folder");
  if (sourcesHere().includes("server")) tabs.push("server");
  return tabs;
}

/**
 * "Add to the library…" (the owner's design, 2026-11-12): a dialog with a tab for folders and one
 * for servers. Where there is only one folder to choose and no server (the web), straight to it.
 */
export function openAdding(): void {
  // Embedded in the landing page: no folder of the person's here; the landing page asks them to
  // the demo, where they can open one.
  if (isEmbed) {
    window.parent.postMessage({ type: "jackbird:demo" }, location.origin);
    return;
  }
  void loadShared();
  const tabs = tabsHere();
  const folders = folderSources();
  // Not where the folder could only be read, or not opened: the dialog says so first.
  if (tabs.length === 1 && tabs[0] === "folder" && folders.length === 1 && adding.shared.length === 0 && (folders[0] !== "device" || deviceAccess() === "full")) {
    void addFrom(folders[0]);
    return;
  }
  adding.open = true;
  adding.tab = folders.length > 0 || !tabs.includes("server") ? "folder" : "server";
  adding.error = "";
}

/** The tab shown: the one chosen, if this runtime has it, else its first. */
export function shownTab(): "folder" | "server" {
  const tabs = tabsHere();
  return tabs.includes(adding.tab) ? adding.tab : (tabs[0] ?? "folder");
}

/** Shows a tab of the dialog. */
export function chooseTab(tab: "folder" | "server"): void {
  adding.tab = tab;
  adding.error = "";
}

export function closeAdding(): void {
  if (!adding.busy) adding.open = false;
}

/** Adds from a folder source: its own dialog (the browser's, the system's, or the server's folders). */
export async function addFrom(kind: SourceKind): Promise<void> {
  if (kind === "server") {
    chooseTab("server");
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
    void loadShared();
  } catch (error) {
    adding.open = true;
    adding.error = error instanceof Error ? error.message : String(error);
  } finally {
    adding.busy = false;
  }
}

/** Opens again a folder closed lately (its source asked as after a restart); says so when it cannot. */
export async function reopenRecent(entry: RecentRoot): Promise<void> {
  adding.open = false;
  library.loading = true;
  library.errorMessage = null;
  try {
    const source = await restoreSource(entry.saved).catch(() => null);
    if (!source) {
      forgetRecent(entry.saved);
      library.errorMessage = t("sources.recentGone", { name: entry.label });
      return;
    }
    await hydrateRoot(source, { rootLabel: entry.label });
  } finally {
    library.loading = false;
  }
}

/** The folders closed lately, for the Folder tab. */
export const recentFolders = (): RecentRoot[] => recent.list;
