// Adding music to the family library (F1): files or folders uploaded from
// this device (editors and up), or a folder of the service's machine imported
// there (owners), with progress and what became of each file. When it ends,
// the library's root is read again. The view is views/import-dialog.html.
// See RECORD/2026-08-11.musikmatch-rust-migration.WIP.md (2026-11-09, 13:46).

import { $reactive, $toRaw } from "jq79";
import { isAudioFile } from "../helpers/formats";
import { account } from "./account";
import { library } from "./library";
import { refreshRoot } from "./roots";
import {
  importFolder,
  importState,
  LIBRARY,
  libraryDownloadUrl,
  librarySuggestions,
  uploadToLibrary,
  type ImportReport,
  type LibrarySuggestion
} from "./sources/service";

export const importing = $reactive({
  /** Whether the service has a library. */
  available: false,
  open: false,
  busy: false,
  done: 0,
  total: 0,
  report: null as ImportReport | null,
  error: ""
});

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function emptyReport(): ImportReport {
  return { added: 0, existing: 0, suggested: 0, unreadable: [] };
}

function refreshLibrary(): void {
  const root = $toRaw(library).roots.find((item) => item.source.saved === LIBRARY);
  if (root) void refreshRoot(root.id);
}

export function openImport(): void {
  importing.open = true;
  importing.report = null;
  importing.error = "";
}

/** Where an upload goes: `Uploads/<who>/<its path in what was picked>`. */
export function uploadPath(file: File, who: string): string {
  const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
  return `Uploads/${who.replace(/[\\/]/g, "-") || "Someone"}/${relative}`;
}

/** Uploads the songs among `files`, one at a time. */
export async function uploadFiles(files: File[]): Promise<void> {
  const songs = files.filter((file) => isAudioFile(file.name));
  const report = emptyReport();
  importing.busy = true;
  importing.error = "";
  importing.done = 0;
  importing.total = songs.length;
  importing.report = null;
  try {
    for (const file of songs) {
      const answer = await uploadToLibrary(uploadPath(file, account.me?.name ?? ""), file).catch((error: Error) => ({
        result: "unreadable" as const,
        why: error.message
      }));
      if (answer.result === "unreadable") report.unreadable.push([file.name, answer.why ?? ""]);
      else report[answer.result] += 1;
      importing.done += 1;
    }
    importing.report = report;
    refreshLibrary();
  } finally {
    importing.busy = false;
  }
}

/** Imports a folder of the service's machine (owners), following it until it ends. */
export async function importMachineFolder(path: string): Promise<void> {
  importing.busy = true;
  importing.error = "";
  importing.report = null;
  try {
    let state = await importFolder(path);
    while (state.running) {
      importing.done = state.done;
      importing.total = state.total;
      await wait(400);
      state = await importState();
    }
    importing.done = state.done;
    importing.total = state.total;
    if (state.error) importing.error = state.error;
    importing.report = state.report;
    refreshLibrary();
  } catch (error) {
    importing.error = error instanceof Error ? error.message : String(error);
  } finally {
    importing.busy = false;
  }
}

/** A library song's download and the other tags brought with it, for Info. */
export const songExtras = $reactive({
  path: "",
  download: "",
  suggestions: [] as LibrarySuggestion[]
});

/** Loads them for a song of the library (or forgets them, given null). */
export async function loadSongExtras(path: string | null): Promise<void> {
  if (path === songExtras.path) return;
  songExtras.path = path ?? "";
  songExtras.download = "";
  songExtras.suggestions = [];
  if (!path) return;
  const [download, suggestions] = await Promise.all([libraryDownloadUrl(path), librarySuggestions(path).catch(() => [])]);
  if (songExtras.path === path) {
    songExtras.download = download;
    songExtras.suggestions = suggestions;
  }
}
