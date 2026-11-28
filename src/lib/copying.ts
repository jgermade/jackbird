// "Copy to…" in the rows' menus (the owner, 2026-11-20): songs of the open tab copied to another.
// A small dialog offers the other tabs (views/copy-dialog.html), those that cannot take songs shown
// off with why, as a drop on them would say it (lib/dropping.ts `targetOf`). The one chosen, the
// drop's dialog opens with the songs, as if dropped there: their new paths by the drop's pattern,
// the tags each lacks, the progress and the report. Each song's bytes are read from its tab only as
// it lands, one at a time. See RECORD/2026-11-03.deck-design-system.WIP.md (2026-11-20).

import { $reactive, $toRaw } from "jq79";
import { tidyTags } from "../helpers/drop";
import { isAudioFile } from "../helpers/formats";
import type { RootWorkspace } from "../types";
import { openDropWith, targetOf, type DropTarget, type DroppedSong } from "./dropping";
import { fileBytes } from "./file-bytes";
import { lookForIpods } from "./ipod";
import { library } from "./library";
import { isDesktop } from "./platform";

export const copying = $reactive({
  open: false,
  /** The tab the songs are in, the songs, and what they are called in the dialog's title. */
  rootId: "",
  trackIds: [] as string[],
  label: ""
});

/** Another tab as the dialog offers it: where the songs would go, or why they cannot. */
export type CopyTab = { id: string; label: string; target: DropTarget | null; why: string };

const rootsOf = (): RootWorkspace[] => $toRaw(library).roots;

/** The tabs other than `rootId`, in the tabs' order. */
export function otherTabs(rootId: string): CopyTab[] {
  return library.roots
    .filter((root) => root.id !== rootId)
    .map((root) => {
      const target = targetOf(root);
      return typeof target === "string" ? { id: root.id, label: root.label, target: null, why: target } : { id: root.id, label: root.label, target, why: "" };
    });
}

/** Whether a tab's songs have anywhere else to go (the menus offer "Copy to…" then). */
export const canCopyFrom = (rootId: string | undefined): boolean => !!rootId && library.roots.some((root) => root.id !== rootId);

/** Asks where to copy songs of a tab. */
export function askCopy(rootId: string, trackIds: readonly string[], label: string): void {
  if (trackIds.length === 0) return;
  // Whether an iPod can be written is known once it is looked for.
  if (isDesktop) void lookForIpods();
  copying.rootId = rootId;
  copying.trackIds = [...trackIds];
  copying.label = label;
  copying.open = true;
}

export function closeCopy(): void {
  copying.open = false;
}

/** The tab chosen: the drop's dialog opens on it with the songs. */
export function copyTo(toRootId: string): void {
  const from = rootsOf().find((root) => root.id === copying.rootId);
  const to = rootsOf().find((root) => root.id === toRootId);
  const target = to ? targetOf(to) : null;
  if (!from || !target || typeof target === "string") return;
  const byId = new Map(from.tracks.map((track) => [track.id, track]));
  const source = from.source;
  // Only MP3s and FLACs are copied: their tags are written on the way and the library takes only
  // them. The others (an iPod's AAC songs) are left out before anything starts, and counted.
  let leftOut = 0;
  const songs: DroppedSong[] = copying.trackIds.flatMap((id) => {
    const track = byId.get(id);
    if (!track) return [];
    const path = track.relativePath;
    if (!isAudioFile(path)) {
      leftOut += 1;
      return [];
    }
    return [
      {
        name: track.name,
        size: track.size,
        from: path,
        read: track.metadata,
        tags: tidyTags(track.metadata),
        bytes: async () => new Uint8Array(await fileBytes(source, path))
      }
    ];
  });
  copying.open = false;
  openDropWith(target, songs, leftOut);
}
