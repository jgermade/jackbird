// The server's details: its space, its machine, its version, and its people and sign-in as tabs
// (views/server-details.html). On the server's own page (the web it serves) they are Preferences,
// Server; connected to a server by its address (the apps, or another server), Preferences has no
// Server section and the foot of Folders (views/server-foot.html) shows them in Details, as an
// iPod's foot shows its sheet, by a row key no tree row has. See
// RECORD/2026-11-03.deck-design-system.WIP.md (2026-11-19, plan G).

import { $reactive } from "jq79";
import type { RootWorkspace } from "../types";
import { currentServer } from "./sources/service";
import { ui } from "./ui";
import { setCurrentRow, showWhole } from "./workspace";

/** Details shows the server's details when a server library's active row is this. */
export const SERVER_ROW = "@server";

export type ServerTab = "summary" | "people" | "signin";
/** What opens over the details from a key of the head: the log, the trash, the backups (the owner, 2026-11-25). */
export type ServerPanel = "log" | "trash" | "backups";

export const serverView = $reactive({ tab: "summary" as ServerTab, panel: null as ServerPanel | null });

/** Whether the server spoken to is the page's own: the web a server serves is that server. */
export const onOwnServer = (): boolean => currentServer().address === "";

/** The server's host name, as its address says (`casa.example.com:4646`); on its own page, the page's. */
export function serverHost(): string {
  const address = currentServer().address;
  if (!address) return typeof location === "undefined" ? "" : location.host;
  try {
    return new URL(address).host;
  } catch {
    return address.replace(/^https?:\/\//, "");
  }
}

/** Whether Details shows the server's details for this root. */
export const showsServerSheet = (root: RootWorkspace | null): boolean => root?.source.kind === "library" && root.activeRowKey === SERVER_ROW;

/** The server's details: Preferences, Server on its own page; Details otherwise. */
export function openServerDetails(): void {
  serverView.tab = "summary";
  serverView.panel = null;
  if (onOwnServer()) {
    ui.preferencesSection = "server";
    ui.preferencesOpen = true;
    return;
  }
  setCurrentRow(SERVER_ROW);
  ui.pane = "details";
}

/** Back from the server's details in Details to its songs. */
export function leaveServerSheet(): void {
  showWhole();
}
