// Adding music to the family library (F1): files or folders uploaded from
// this device (editors and up), or a folder of the service's machine imported
// there (owners), with progress and what became of each file. When it ends,
// the library's root is read again. The view is views/import-dialog.html.
// See RECORD/2026-08-11.musikmatch-rust-migration.WIP.md (2026-11-09, 13:46).
//
// In the Android app a folder is chosen in Android's own picker and its songs are sent by the
// plugin, read as they go (lib/sources/phone.ts). In the apps, away from the server's home network
// address, a batch goes straight to that address when it answers as the same server, with the same
// session, and by the usual address otherwise or once it stops answering. See
// RECORD/2026-11-03.deck-design-system.WIP.md (2026-11-19).

import { $reactive, $toRaw } from "jq79";
import { isAudioFile } from "../helpers/formats";
import { isHomeAddress } from "../helpers/instance";
import { folderUpload, isHandheld, type FolderUpload } from "../helpers/picked";
import { t } from "./i18n";
import { library } from "./library";
import { isDesktop, isPhone } from "./platform";
import { refreshRoot } from "./roots";
import {
  currentServer,
  homeAddresses,
  importFolder,
  importState,
  instanceAt,
  libraryDownloadUrl,
  librarySuggestions,
  uploadAnswer,
  uploadTarget,
  uploadToLibrary,
  type ImportReport,
  type LibrarySuggestion,
  type Uploaded
} from "./sources/service";

export const importing = $reactive({
  /** Whether the service has a library. */
  available: false,
  open: false,
  busy: false,
  done: 0,
  total: 0,
  report: null as ImportReport | null,
  error: "",
  /** Whether the songs go over the server's home network now, not by its usual address. */
  home: false,
  /** The bytes of the songs uploaded so far, of the one going (as it goes), and of them all; 0 in
   *  all when the sizes are not known (a folder of the server's machine, or a provider of the
   *  Android app's folder that tells none): then the bar goes by songs. */
  bytesDone: 0,
  bytesSent: 0,
  bytesTotal: 0
});

/** How much of it is done, 0 to 100: by the bytes when they are known, else by the songs. */
export function importShare(): number {
  const share = importing.bytesTotal > 0 ? (importing.bytesDone + importing.bytesSent) / importing.bytesTotal : importing.total > 0 ? importing.done / importing.total : 0;
  return Math.min(100, Math.round(share * 100));
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function emptyReport(): ImportReport {
  return { added: 0, existing: 0, suggested: 0, unreadable: [] };
}

function refreshLibrary(): void {
  const server = currentServer();
  const root = $toRaw(library).roots.find((item) => item.source.kind === "library" && item.source.server === server && item.source.shelf === undefined);
  if (root) void refreshRoot(root.id);
}

export function openImport(): void {
  importing.open = true;
  importing.report = null;
  importing.error = "";
}

/** How a folder is uploaded here: Android's own picker (the app), a folder input, or not at all. */
export function folderUploadHere(): FolderUpload {
  if (typeof navigator === "undefined") return "none";
  return folderUpload({
    app: isDesktop,
    android: /Android/.test(navigator.userAgent),
    folderInput: typeof HTMLInputElement !== "undefined" && "webkitdirectory" in HTMLInputElement.prototype,
    handheld: isPhone || isHandheld(navigator.userAgent, navigator.maxTouchPoints ?? 0)
  });
}

/**
 * Where an upload goes: at the root of one's own music, as it was in what was picked (no longer under
 * `Uploads/<who>/`: each person's music is their own since shelves, and a name changes; 2026-11-19).
 */
export function uploadPath(relative: string): string {
  return relative.replace(/^\/+/, "");
}

/**
 * One song to upload: its name, for the report, its size when known, and how it is sent, to a home
 * address or (null) the usual one, telling the bytes sent as they go when it can.
 */
type Song = { name: string; size?: number; send(at: string | null, sent: (bytes: number) => void): Promise<Uploaded> };

/** A song's `send` throws this when the server could not be reached at all (not when it answered). */
class Unreached extends Error {}

const failed = (error: unknown): Uploaded => ({
  result: "unreadable",
  // The quota (refused by the service before the file is taken): said in the person's language.
  why: (error as { code?: string } | null)?.code === "quota" ? t("import.overQuota") : error instanceof Error ? error.message : String(error)
});

/**
 * The server's address on its home network, for an app that speaks to it from elsewhere (through a
 * tunnel, say): one of the addresses it says it listens on there that answers, within a moment, as
 * the same instance. Null where there is none, or where the app is at a home address already.
 */
async function homeRoute(): Promise<string | null> {
  if (!isPhone) return null;
  const server = currentServer();
  if (!server.address || isHomeAddress(server.address)) return null;
  const [addresses, mine] = await Promise.all([homeAddresses().catch(() => [] as string[]), instanceAt(server.address, 5000)]);
  if (!mine || addresses.length === 0) return null;
  const answers = await Promise.all(addresses.map((address) => instanceAt(address)));
  return addresses.find((_, index) => answers[index] === mine) ?? null;
}

/** Uploads songs one at a time, with the dialog's progress and report; the library read again after. */
async function uploadSongs(songs: Song[]): Promise<void> {
  const report = emptyReport();
  importing.busy = true;
  importing.error = "";
  importing.done = 0;
  importing.total = songs.length;
  importing.report = null;
  importing.home = false;
  const sized = songs.every((song) => song.size !== undefined);
  importing.bytesDone = 0;
  importing.bytesSent = 0;
  importing.bytesTotal = sized ? songs.reduce((sum, song) => sum + (song.size ?? 0), 0) : 0;
  try {
    let at = songs.length > 0 ? await homeRoute() : null;
    importing.home = at !== null;
    for (const song of songs) {
      let answer: Uploaded;
      const sent = (bytes: number) => (importing.bytesSent = Math.min(bytes, song.size ?? bytes));
      try {
        answer = await song.send(at, sent);
      } catch (error) {
        if (error instanceof Unreached && at !== null) {
          // The home address stopped answering (the phone left its Wi-Fi): this one and the rest
          // go by the usual address.
          at = null;
          importing.home = false;
          importing.bytesSent = 0;
          answer = await song.send(null, sent).catch(failed);
        } else {
          answer = failed(error);
        }
      }
      if (answer.result === "unreadable") report.unreadable.push([song.name, answer.why ?? ""]);
      else report[answer.result] += 1;
      importing.done += 1;
      importing.bytesDone += song.size ?? 0;
      importing.bytesSent = 0;
    }
    importing.report = report;
    refreshLibrary();
  } finally {
    importing.busy = false;
    importing.home = false;
  }
}

/** Uploads the songs among `files` (chosen in the page: songs, or a folder's files). */
export function uploadFiles(files: File[]): Promise<void> {
  const songs = files
    .filter((file) => isAudioFile(file.name))
    .map((file): Song => {
      const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
      return {
        name: file.name,
        size: file.size,
        async send(at, sent) {
          try {
            return await uploadToLibrary(uploadPath(relative), file, at ?? undefined, sent);
          } catch (error) {
            // `fetch` fails with a TypeError only when the server was not reached.
            throw error instanceof TypeError ? new Unreached(error.message) : error;
          }
        }
      };
    });
  return uploadSongs(songs);
}

/** The Android app: a folder chosen in Android's own picker, its songs sent by the plugin as they are read. */
export async function uploadPhoneFolder(): Promise<void> {
  const { pickPhoneUpload, uploadPhoneFile } = await import("./sources/phone");
  importing.error = "";
  importing.report = null;
  let picked: Awaited<ReturnType<typeof pickPhoneUpload>>;
  try {
    picked = await pickPhoneUpload();
  } catch (error) {
    importing.error = error instanceof Error ? error.message : String(error);
    return;
  }
  if (!picked) return;
  const { tree, name } = picked;
  const songs = picked.files
    .filter((file) => isAudioFile(file.path))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map(({ path, size }): Song => ({
      name: path.slice(path.lastIndexOf("/") + 1),
      size,
      async send(at, sent) {
        const target = uploadTarget(uploadPath(`${name}/${path}`), at ?? undefined);
        let reply: { status: number; body: string };
        try {
          reply = await uploadPhoneFile(tree, path, target.url, target.authorization, sent);
        } catch (error) {
          throw new Unreached(error instanceof Error ? error.message : String(error));
        }
        return uploadAnswer(reply.status, reply.body);
      }
    }));
  await uploadSongs(songs);
}

/** Imports a folder of the service's machine (owners), following it until it ends. */
export async function importMachineFolder(path: string): Promise<void> {
  importing.busy = true;
  importing.bytesTotal = 0;
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
  // Of the music in view: one's own, or someone's shared with one (SH-D6).
  const raw = $toRaw(library);
  const shelf = raw.roots.find((root) => root.id === raw.activeRootId)?.source.shelf;
  const [download, suggestions] = await Promise.all([libraryDownloadUrl(path, shelf), librarySuggestions(path, shelf).catch(() => [])]);
  if (songExtras.path === path) {
    songExtras.download = download;
    songExtras.suggestions = suggestions;
  }
}
