// The iPod in the app (the panel, RECORD/2026-11-14.ipod-sync.WIP.md): the iPods plugged in, one
// opened as a root (lib/sources/ipod.ts), and songs sent to it from the app's folders or taken off
// it, each asked first in views/ipod-dialog.html. The desktop app only: it reaches the iPod's disk
// and USB through its commands (src-tauri/src/ipod.rs).

import { $reactive, $toRaw } from "jq79";
import { parseSaved } from "../helpers/instance";
import { isSendable, likelyDuplicates } from "../helpers/ipod";
import type { RootWorkspace } from "../types";
import { t, tn } from "./i18n";
import { library } from "./library";
import { isDesktop, isPhone } from "./platform";
import { closeRoot, hydrateRoot } from "./roots";
import type { IpodInfo } from "./sources/ipod";

/** What the iPod dialog asks. */
export type IpodDialog =
  | {
      mode: "send";
      /** The iPods it can go to, the first chosen. */
      targets: IpodInfo[];
      target: string;
      /** The files, of the app's open folders. */
      files: { root: string; path: string; title: string; artist: string }[];
      /** The positions of those that look like songs the iPod has (left out unless the person keeps them). */
      duplicates: number[];
      keepDuplicates: boolean;
      /** Songs of the selection that cannot go (not MP3s). */
      skipped: number;
    }
  | { mode: "remove"; rootId: string; paths: string[]; label: string };

export const ipods = $reactive({
  /** The iPods plugged in, as last looked for. */
  found: [] as IpodInfo[],
  dialog: null as IpodDialog | null,
  busy: false,
  error: "",
  /** What the last send or removal did, said once. */
  done: ""
});

/** Whether this app can reach an iPod: the desktop app on a computer. */
export const ipodsHere = (): boolean => isDesktop && !isPhone;

/** Looks for the iPods plugged in. */
export async function lookForIpods(): Promise<void> {
  if (!ipodsHere()) return;
  const { listIpods } = await import("./sources/ipod");
  ipods.found = await listIpods().catch(() => []);
}

/** The open iPods' roots. */
export function ipodRoots(): RootWorkspace[] {
  return $toRaw(library).roots.filter((root) => !!root.source.ipod);
}

/** Opens an iPod as a root, or shows it if it is open; reads its SysInfoExtended over USB first when it lacks it. */
export async function openIpodRoot(info: IpodInfo): Promise<void> {
  const open = ipodRoots().find((root) => root.source.ipod?.path === info.path);
  if (open) {
    library.activeRootId = open.id;
    return;
  }
  const { openIpod, saveSysinfo } = await import("./sources/ipod");
  library.errorMessage = null;
  try {
    if (info.needsSysinfo) {
      await saveSysinfo(info.path);
      await lookForIpods();
    }
    const fresh = ipods.found.find((one) => one.path === info.path) ?? info;
    await hydrateRoot(await openIpod(fresh), { rootLabel: fresh.name, groupingMode: "wizard" });
    library.infoMessage = t("ipod.opened");
  } catch (error) {
    library.errorMessage = error instanceof Error ? error.message : String(error);
  }
}

/** Reads an open iPod's songs again, after its databases changed. */
async function reloadIpod(path: string): Promise<void> {
  const open = ipodRoots().find((root) => root.source.ipod?.path === path);
  const info = ipods.found.find((one) => one.path === path);
  if (!open || !info) return;
  const { openIpod } = await import("./sources/ipod");
  await hydrateRoot(await openIpod(info), { rootId: open.id, rootLabel: open.label, setActive: false });
}

/**
 * The folder of this machine a root's files are in, by its path: a folder the app opened, or one
 * the installed service serves (the app as its interface: a root of the home server, kept by its
 * path alone). Null for any other root.
 */
function localFolder(root: RootWorkspace): string | null {
  if (root.source.ipod || typeof root.source.saved !== "string") return null;
  if (root.source.kind === "desktop") return root.source.saved;
  const saved = parseSaved(root.source.saved);
  return root.source.kind === "service" && saved.server === null ? saved.path : null;
}

/** Whether "Send to iPod" is offered for the active root's songs: an iPod can take them, and they are in a folder of this machine. */
export function canSendFrom(root: RootWorkspace | null): boolean {
  return !!root && localFolder(root) !== null && ipods.found.some((one) => one.writable);
}

/** Asks before sending songs of a root to an iPod. */
export async function askSend(rootId: string, trackIds: string[]): Promise<void> {
  await lookForIpods();
  const root = $toRaw(library).roots.find((one) => one.id === rootId);
  const targets = ipods.found.filter((one) => one.writable);
  const folder = root ? localFolder(root) : null;
  if (!root || folder === null || targets.length === 0) return;
  const tracks = trackIds
    .map((id) => root.tracks.find((track) => track.id === id))
    .filter((track) => !!track);
  const sendable = tracks.filter((track) => isSendable(track.relativePath));
  const target = targets[0].path;
  const files = sendable.map((track) => ({
    root: folder,
    path: track.relativePath,
    title: track.metadata.title || track.name,
    artist: track.metadata.artist
  }));
  ipods.error = "";
  ipods.dialog = {
    mode: "send",
    targets,
    target,
    files,
    duplicates: duplicatesOn(target, files),
    keepDuplicates: false,
    skipped: tracks.length - sendable.length
  };
}

/** The positions of the songs that look like ones on the iPod at `path`, by what its open root lists. */
function duplicatesOn(path: string, songs: { title: string; artist: string }[]): number[] {
  const open = ipodRoots().find((root) => root.source.ipod?.path === path);
  const existing = (open?.tracks ?? []).map((track) => ({ title: track.metadata.title, artist: track.metadata.artist }));
  return likelyDuplicates(songs, existing);
}

/** Chooses another iPod to send to. */
export function chooseTarget(path: string): void {
  const dialog = ipods.dialog;
  if (dialog?.mode !== "send") return;
  ipods.dialog = { ...dialog, target: path, duplicates: duplicatesOn(path, dialog.files) };
}

/** The files a send will take, the duplicates left out unless kept. */
export function filesToSend(dialog: Extract<IpodDialog, { mode: "send" }>): { root: string; path: string }[] {
  const leftOut = new Set(dialog.keepDuplicates ? [] : dialog.duplicates);
  return dialog.files.filter((_, index) => !leftOut.has(index)).map(({ root, path }) => ({ root, path }));
}

/** Sends what the dialog lists. */
export async function confirmSend(): Promise<void> {
  const dialog = ipods.dialog;
  if (dialog?.mode !== "send" || ipods.busy) return;
  const files = filesToSend(dialog);
  if (files.length === 0) {
    ipods.dialog = null;
    return;
  }
  ipods.busy = true;
  ipods.error = "";
  try {
    const { sendFiles } = await import("./sources/ipod");
    const sent = await sendFiles(dialog.target, files);
    const covers = sent.filter((one) => one.cover).length;
    ipods.done = tn("ipod.sent", sent.length, { covers });
    library.infoMessage = ipods.done;
    ipods.dialog = null;
    await reloadIpod(dialog.target);
  } catch (error) {
    ipods.error = error instanceof Error ? error.message : String(error);
  } finally {
    ipods.busy = false;
  }
}

/** Asks before taking songs of an iPod's root off it. */
export function askRemove(rootId: string, trackIds: string[]): void {
  const root = $toRaw(library).roots.find((one) => one.id === rootId);
  if (!root?.source.ipod || trackIds.length === 0) return;
  const first = root.tracks.find((track) => track.id === trackIds[0]);
  ipods.error = "";
  ipods.dialog = {
    mode: "remove",
    rootId,
    paths: trackIds,
    label: trackIds.length === 1 && first ? first.metadata.title || first.name : tn("tracks.count", trackIds.length)
  };
}

/** Takes what the dialog lists off the iPod. */
export async function confirmRemove(): Promise<void> {
  const dialog = ipods.dialog;
  if (dialog?.mode !== "remove" || ipods.busy) return;
  const root = $toRaw(library).roots.find((one) => one.id === dialog.rootId);
  const ipod = root?.source.ipod;
  if (!root || !ipod) return;
  ipods.busy = true;
  ipods.error = "";
  try {
    const pids = (await Promise.all(dialog.paths.map((path) => ipod.pidOf(path)))).filter((pid): pid is string => !!pid);
    const { removePids } = await import("./sources/ipod");
    const removed = await removePids(ipod.path, pids);
    ipods.done = tn("ipod.removed", removed);
    library.infoMessage = ipods.done;
    ipods.dialog = null;
    await reloadIpod(ipod.path);
  } catch (error) {
    ipods.error = error instanceof Error ? error.message : String(error);
  } finally {
    ipods.busy = false;
  }
}

/** Closes the dialog. */
export function closeIpodDialog(): void {
  if (!ipods.busy) ipods.dialog = null;
}

/** The dialog's title. */
export function ipodDialogTitle(): string {
  const dialog = ipods.dialog;
  if (!dialog) return "";
  return dialog.mode === "send" ? tn("ipod.sendTitle", dialog.files.length) : t("ipod.removeTitle", { name: dialog.label });
}

/** Closes an iPod's root when it is unplugged (it is gone from the iPods found). */
export function closeUnpluggedIpods(): void {
  for (const root of ipodRoots()) {
    if (!ipods.found.some((one) => one.path === root.source.ipod?.path)) closeRoot(root.id);
  }
}
