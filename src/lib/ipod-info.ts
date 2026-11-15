// An open iPod's foot in the library and its sheet in Details (W5, RECORD/2026-11-14.ipod-sync.WIP.md):
// what the iPod says of itself and of its drive, asked once per root (`source.ipod.info()`: the
// desktop app's `ipod_info`, or the web's iPod module), again after songs are sent to it or taken
// off; and Details showing the iPod's sheet, by a row key no tree row has (IPOD_ROW).

import { $reactive, $toRaw } from "jq79";
import { IPOD_ROW, formatDriveSize, ipodUsage, libraryCounts, usageParts, type ContentKind } from "../helpers/ipod";
import type { IpodDeviceInfo, RootWorkspace } from "../types";
import { t } from "./i18n";
import { library } from "./library";
import { preferences } from "./preferences";
import { ui } from "./ui";
import { setCurrentRow, showWhole } from "./workspace";

/** Each open iPod's facts, by its root's id: asked (`null`) or known. A root that could not tell has none. */
export const ipodInfo = $reactive({ byRoot: {} as Record<string, IpodDeviceInfo | null> });

/** What a root's iPod said; null until it has (or when it cannot). */
export function infoOf(root: RootWorkspace | null): IpodDeviceInfo | null {
  return root ? (ipodInfo.byRoot[root.id] ?? null) : null;
}

/** Asks an iPod's root for its facts, unless they were asked already (or `again`). */
export async function loadIpodInfo(rootId: string, again = false): Promise<void> {
  const root = $toRaw(library).roots.find((one) => one.id === rootId);
  const ipod = root?.source.ipod;
  // Read raw: an effect that asks does not wake again on the answer.
  if (!ipod || (!again && rootId in $toRaw(ipodInfo).byRoot)) return;
  const known = $toRaw(ipodInfo).byRoot;
  ipodInfo.byRoot = { ...known, [rootId]: known[rootId] ?? null };
  try {
    const info = await ipod.info();
    ipodInfo.byRoot = { ...$toRaw(ipodInfo).byRoot, [rootId]: info };
  } catch (error) {
    console.error("jackbird: could not read the iPod's details", error);
  }
}

/** Whether Details shows the iPod's sheet for this root. */
export const showsIpodSheet = (root: RootWorkspace | null): boolean => !!root?.source.ipod && root.activeRowKey === IPOD_ROW;

/** Shows the active iPod's sheet in Details; on a phone, brings Details into view. */
export function showIpodSheet(): void {
  setCurrentRow(IPOD_ROW);
  ui.pane = "details";
}

/** Back from the iPod's sheet to its songs. */
export function leaveIpodSheet(): void {
  showWhole();
}

/** Each kind of content's colour in the space bar (W5b): the theme's tones. */
const TONES: Record<ContentKind, "accent" | "stripe-1" | "stripe-2" | "info" | "muted"> = {
  music: "accent",
  covers: "stripe-2",
  photos: "info",
  rockbox: "stripe-1",
  other: "muted"
};

/** A size as the iPod's foot and sheet show it, in the app's language. */
export const driveSize = (bytes: number): string => formatDriveSize(bytes, preferences.language);

/** What an iPod's root shows of its space: the space bar's parts, its whole and its free space; null where the drive's size is unknown (a browser). */
export type SpaceBar = {
  parts: { label: string; amount: number; caption: string; tone: (typeof TONES)[ContentKind] }[];
  max: number;
  used: number;
  free: number;
};

/** The space bar of an iPod's root, from what it said and its songs (the music). */
export function spaceBar(root: RootWorkspace | null): SpaceBar | null {
  const info = infoOf(root);
  const usage = ipodUsage(info?.total ?? null, info?.free ?? null, libraryCounts(root?.tracks ?? []).bytes);
  if (usage.total === null || usage.used === null || usage.free === null) return null;
  const parts = usageParts(usage, { artwork: info?.artworkBytes ?? null, photos: info?.photoBytes ?? null, rockbox: info?.rockboxBytes ?? null });
  return {
    parts: parts.map((part) => ({ label: t(`ipod.content.${part.kind}`), amount: part.bytes, caption: driveSize(part.bytes), tone: TONES[part.kind] })),
    max: usage.total,
    used: usage.used,
    free: usage.free
  };
}
