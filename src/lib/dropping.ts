// Songs dropped on the library (RECORD/2026-11-03.deck-design-system.WIP.md, 2026-11-19, plan H):
// over the library and Details a placeholder says where they would go (views/drop-zone.html); once
// dropped, a dialog shows each song's new path, by a pattern of one's own, and asks for the tags it
// lacks, which it can read from the dropped name (views/drop-dialog.html); then each lands as a
// copy, its tags tidied: one's own music on a server (uploaded), a folder (written into it), or an
// iPod (staged on the machine and sent as the send to iPod does; the desktop app).

import { $reactive, $toRaw } from "jq79";
import { isCompilation } from "../helpers/metadata";
import { DEFAULT_COMPILATION_PATTERN, DEFAULT_DROP_PATTERN, DEFAULT_READ_PATTERN, dropPath, freePath, missingTags, patternFor, recoverTags, tagsChanged, tidyTags, type DropTag } from "../helpers/drop";
import { isAudioFile } from "../helpers/formats";
import type { RootWorkspace, TrackMetadata } from "../types";
import { t } from "./i18n";
import { ipods, lookForIpods, reloadIpod } from "./ipod";
import { library } from "./library";
import { isDesktop } from "./platform";
import { refreshRoot } from "./roots";
import { STORAGE_KEYS, readStored, writeStored } from "./storage";
import { readBlobTags, writeTags } from "./tags";
import { uploadToLibrary } from "./sources/service";

/** Where a drop goes: the active root, and what it is. */
export type DropTarget = { rootId: string; kind: "server" | "folder" | "ipod"; label: string };

/**
 * A song dropped (or copied from another tab, lib/copying.ts): its file's name and size, where it
 * was in what was dropped (or in its tab), its tags as read and as they will be, and its bytes,
 * read only as it lands.
 */
export type DroppedSong = { name: string; size: number; from: string; read: TrackMetadata; tags: TrackMetadata; bytes: () => Promise<Uint8Array> };

export type DropReport = { added: number; existing: number; failed: [string, string][]; leftOut: number };

export const dropping = $reactive({
  /** Files are being dragged over the area. */
  over: false,
  /** What a drop would do there: where, or why not. */
  target: null as DropTarget | null,
  refusal: "",
  /** The dialog, once dropped: the songs, what was not a song, and the patterns. */
  open: false,
  /** The songs come from another tab ("Copy to…"), not dropped. */
  copied: false,
  reading: false,
  songs: [] as DroppedSong[],
  leftOut: 0,
  pattern: readStored(STORAGE_KEYS.dropPattern) || DEFAULT_DROP_PATTERN,
  readPattern: readStored(STORAGE_KEYS.dropReadPattern) || DEFAULT_READ_PATTERN,
  /** The pattern a compilation's path is made by (`_compilations/%album%/…`). */
  compilationPattern: readStored(STORAGE_KEYS.dropCompilationPattern) || DEFAULT_COMPILATION_PATTERN,
  busy: false,
  done: 0,
  /** The name of the file being added, while the songs are added. */
  current: "",
  /** The bytes of the songs added so far (each as it is done), and of them all: the progress bar. */
  bytesDone: 0,
  bytesTotal: 0,
  /** The bytes of the song being uploaded that have gone so far (to a server; 0 elsewhere). */
  bytesSent: 0,
  report: null as DropReport | null,
  error: ""
});

/** Where a drop on `root` would go, or why it cannot (a text for the placeholder). */
export function targetOf(root: RootWorkspace | null): DropTarget | string {
  if (!root) return t("drop.noRoot");
  const source = root.source;
  if (source.kind === "library") {
    return source.shelf === undefined ? { rootId: root.id, kind: "server", label: root.label } : t("drop.shared");
  }
  if (source.ipod) {
    const writable = isDesktop && ipods.found.some((one) => one.path === source.ipod?.path && one.writable);
    return writable ? { rootId: root.id, kind: "ipod", label: root.label } : t("drop.ipodReadOnly");
  }
  if (source.readOnly) return t("drop.readOnly");
  return { rootId: root.id, kind: "folder", label: root.label };
}

const activeRoot = (): RootWorkspace | null => {
  const raw = $toRaw(library);
  return raw.roots.find((root) => root.id === raw.activeRootId) ?? null;
};

/** Files dragged in from outside (a row dragged within the app carries none). */
export const carriesFiles = (event: DragEvent): boolean => Array.from(event.dataTransfer?.types ?? []).includes("Files");

/** How deep the drag is in the area: each element it enters counts, each it leaves uncounts. */
let depth = 0;

/** Files entered the area (or an element in it): what a drop would do. */
export function dragEntered(event: DragEvent): void {
  if (!carriesFiles(event)) return;
  event.preventDefault();
  depth += 1;
  dragOver();
}

/** Files moving over the area: a drop is let happen (and says it copies). */
export function dragMoved(event: DragEvent): void {
  if (!carriesFiles(event)) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = dropping.target ? "copy" : "none";
  dragOver();
}

/** Files left an element of the area; out of it, the placeholder goes. */
export function dragExited(event: DragEvent): void {
  if (!carriesFiles(event)) return;
  depth = Math.max(0, depth - 1);
  if (depth === 0) dragLeft();
}

/** Files dropped on the area. */
export function dropped(event: DragEvent): void {
  if (!carriesFiles(event)) return;
  event.preventDefault();
  depth = 0;
  void drop(event);
}

function dragOver(): void {
  if (dropping.over) return;
  if (isDesktop) void lookForIpods();
  const target = targetOf(activeRoot());
  dropping.target = typeof target === "string" ? null : target;
  dropping.refusal = typeof target === "string" ? target : "";
  dropping.over = true;
}

export function dragLeft(): void {
  depth = 0;
  dropping.over = false;
}

/** Every file under an entry, with its path in what was dropped. */
async function filesOf(entry: FileSystemEntry): Promise<{ file: File; path: string }[]> {
  if (entry.isFile) {
    const file = await new Promise<File>((ok, fail) => (entry as FileSystemFileEntry).file(ok, fail));
    return [{ file, path: entry.fullPath.replace(/^\/+/, "") || file.name }];
  }
  if (!entry.isDirectory) return [];
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  const all: FileSystemEntry[] = [];
  // readEntries answers in batches, until an empty one.
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((ok, fail) => reader.readEntries(ok, fail));
    if (batch.length === 0) break;
    all.push(...batch);
  }
  return (await Promise.all(all.map(filesOf))).flat();
}

/** The files a drop brought, folders walked: read at once, while the drop's items can still be. */
function droppedFiles(transfer: DataTransfer): Promise<{ file: File; path: string }[]> {
  const entries = Array.from(transfer.items ?? [])
    .map((item) => (item.kind === "file" ? item.webkitGetAsEntry() : null))
    .filter((entry): entry is FileSystemEntry => entry !== null);
  if (entries.length > 0) return Promise.all(entries.map(filesOf)).then((lists) => lists.flat());
  return Promise.resolve(Array.from(transfer.files).map((file) => ({ file, path: file.name })));
}

/** Files dropped: their songs' tags read, and the dialog opened. */
export async function drop(event: DragEvent): Promise<void> {
  dropping.over = false;
  const transfer = event.dataTransfer;
  if (!transfer || !dropping.target) return;
  const files = droppedFiles(transfer);
  dropping.open = true;
  dropping.copied = false;
  dropping.reading = true;
  dropping.songs = [];
  dropping.report = null;
  dropping.error = "";
  dropping.done = 0;
  try {
    const all = await files;
    const songs = all.filter(({ file }) => isAudioFile(file.name));
    dropping.leftOut = all.length - songs.length;
    const read: DroppedSong[] = [];
    for (const { file, path } of songs) {
      const tags = await readBlobTags(file).catch(() => null);
      if (!tags) {
        dropping.leftOut += 1;
        continue;
      }
      read.push({ name: file.name, size: file.size, from: path, read: tags, tags: tidyTags(tags), bytes: async () => new Uint8Array(await file.arrayBuffer()) });
    }
    dropping.songs = read;
  } catch (error) {
    dropping.error = error instanceof Error ? error.message : String(error);
  } finally {
    dropping.reading = false;
  }
}

/**
 * Songs of another tab to copy to `target` (lib/copying.ts): the drop's dialog opens with them, as
 * if they had been dropped there.
 */
export function openDropWith(target: DropTarget, songs: DroppedSong[]): void {
  dropping.target = target;
  dropping.refusal = "";
  dropping.songs = songs;
  dropping.leftOut = 0;
  dropping.report = null;
  dropping.error = "";
  dropping.done = 0;
  dropping.reading = false;
  dropping.copied = true;
  dropping.open = true;
}

/** The pattern the paths are made by, kept for the next time. */
export function setDropPattern(pattern: string): void {
  dropping.pattern = pattern;
  writeStored(STORAGE_KEYS.dropPattern, pattern);
}

/** The pattern the compilations' paths are made by, kept for the next time. */
export function setCompilationPattern(pattern: string): void {
  dropping.compilationPattern = pattern;
  writeStored(STORAGE_KEYS.dropCompilationPattern, pattern);
}

export function setReadPattern(pattern: string): void {
  dropping.readPattern = pattern;
  writeStored(STORAGE_KEYS.dropReadPattern, pattern);
}

/** What a song lacks, and where it would land. */
/** The pattern a song goes by: the compilations' for one its tags mark so, else everyone's. */
const patternOf = (song: DroppedSong): string => patternFor(song.tags, dropping.pattern, dropping.compilationPattern);
export const missingOf = (song: DroppedSong): DropTag[] => missingTags(patternOf(song), song.tags);
export const pathOf = (song: DroppedSong): string => dropPath(patternOf(song), song.name, song.tags);
/** Whether any dropped song is a compilation: the dialog then shows their pattern too. */
export const hasCompilations = (): boolean => dropping.songs.some((song) => isCompilation({ compilation: String(song.tags.compilation ?? "") }));

/** A tag typed for a song. */
export function setTag(index: number, tag: DropTag, value: string): void {
  const songs = [...$toRaw(dropping).songs];
  const song = songs[index];
  if (!song) return;
  songs[index] = { ...song, tags: { ...song.tags, [tag]: value } };
  dropping.songs = songs;
}

/** What each song's dropped path gives of the tags it lacks, by the read pattern: how many songs it filled. */
export function readFromNames(): number {
  let filled = 0;
  dropping.songs = $toRaw(dropping).songs.map((song) => {
    const read = recoverTags(dropping.readPattern, song.from, song.tags);
    if (Object.keys(read).length === 0) return song;
    filled += 1;
    return { ...song, tags: tidyTags({ ...song.tags, ...read }) };
  });
  return filled;
}

export function closeDrop(): void {
  if (dropping.busy) return;
  dropping.open = false;
  dropping.songs = [];
}

/** A song's bytes as it lands: its tags written where they changed. */
async function copyOf(song: DroppedSong): Promise<Uint8Array> {
  const bytes = await song.bytes();
  const tags = tidyTags(song.tags);
  return tagsChanged(song.read, tags) ? writeTags(bytes, song.read, tags) : bytes;
}

/** Every song lands where the drop was. */
export async function confirmDrop(): Promise<void> {
  const target = dropping.target;
  const root = target ? $toRaw(library).roots.find((one) => one.id === target.rootId) : null;
  if (!target || !root || dropping.busy) return;
  const songs = [...$toRaw(dropping).songs];
  const report: DropReport = { added: 0, existing: 0, failed: [], leftOut: dropping.leftOut };
  dropping.busy = true;
  dropping.done = 0;
  dropping.bytesDone = 0;
  dropping.bytesSent = 0;
  dropping.bytesTotal = songs.reduce((sum, song) => sum + song.size, 0);
  dropping.error = "";
  const failed = (song: DroppedSong, error: unknown) => report.failed.push([song.from, error instanceof Error ? error.message : String(error)]);
  try {
    if (target.kind === "server") {
      for (const song of songs) {
        dropping.current = song.name;
        try {
          const sent = (bytes: number) => (dropping.bytesSent = Math.min(bytes, song.size));
          const answer = await uploadToLibrary(pathOf(song), new Blob([(await copyOf(song)).slice()]), undefined, sent);
          if (answer.result === "added" || answer.result === "suggested") report.added += 1;
          else if (answer.result === "existing") report.existing += 1;
          else report.failed.push([song.from, answer.why ?? ""]);
        } catch (error) {
          failed(song, error);
        }
        dropping.done += 1;
        dropping.bytesDone += song.size;
        dropping.bytesSent = 0;
      }
    } else if (target.kind === "folder") {
      const taken = new Set(root.tracks.map((track) => track.relativePath.toLowerCase()));
      for (const song of songs) {
        dropping.current = song.name;
        try {
          const path = freePath(pathOf(song), taken);
          await root.source.vfs.write(path, await copyOf(song));
          taken.add(path.toLowerCase());
          report.added += 1;
        } catch (error) {
          failed(song, error);
        }
        dropping.done += 1;
        dropping.bytesDone += song.size;
      }
    } else {
      const ipod = root.source.ipod?.path;
      const { releaseStaging, stageDrop } = await import("./sources/desktop");
      const { sendFiles } = await import("./sources/ipod");
      const staging = await stageDrop();
      try {
        const staged: { root: string; path: string }[] = [];
        const taken = new Set<string>();
        for (const song of songs) {
          dropping.current = song.name;
          try {
            const path = freePath(pathOf(song), taken);
            await staging.vfs.write(path, await copyOf(song));
            taken.add(path.toLowerCase());
            staged.push({ root: staging.root, path });
          } catch (error) {
            failed(song, error);
          }
          dropping.done += 1;
          dropping.bytesDone += song.size;
        }
        if (ipod && staged.length > 0) {
          const sent = await sendFiles(ipod, staged);
          report.added += sent.length;
          await reloadIpod(ipod);
        }
      } finally {
        await releaseStaging(staging.root).catch(() => undefined);
      }
    }
    if (target.kind !== "ipod") await refreshRoot(root.id);
    dropping.report = report;
  } catch (error) {
    dropping.error = error instanceof Error ? error.message : String(error);
  } finally {
    dropping.busy = false;
    dropping.current = "";
  }
}
