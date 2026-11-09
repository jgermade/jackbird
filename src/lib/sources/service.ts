// A root on jackbird's service (S1): a folder of the machine the service
// runs on, by its path, every operation an HTTP request to the page's own
// origin (crates/service). As on the desktop, the tags and checksums are
// worked out by the service; only small files (`.meta/`, playlists) travel
// whole. Playback is the service's own URL, with byte ranges. With people
// (S3), the page's requests carry its session's cookie; the desktop app,
// another origin, keeps a token instead and sends it as a bearer, and its
// media URLs carry a media token, since an <audio> sends no header. See
// RECORD/2026-08-11.musikmatch-rust-migration.WIP.md (S1-D5, S3).

import type { VFSAdapter, VFSListEntry, VFSStat } from "@cloudauthn/vfs-sync";
import type { Inspection, MediaHandle, RootSource, TrackMetadata } from "../../types";
import { TagError } from "../tags";

type Failure = { code?: string; message?: string };

/** Where the service is: the page's own origin, or, in the desktop app, its address (S2). */
let base = "";

/** Asks the service at this address (`http://127.0.0.1:4646`) instead of the page's own origin. */
export function useServiceAt(address: string): void {
  base = address.replace(/\/$/, "");
}

const TOKEN_KEY = "jackbird.serviceToken";

/** The desktop app's session token (the page's own session is a cookie). */
function storedToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

/** Keeps (or forgets) the desktop app's session token. */
export function setServiceToken(token: string | null): void {
  mediaGrant = null;
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Without storage, the app signs in again next time.
  }
}

/** Whether sessions travel as a bearer token: the desktop app, which reaches the service from another origin. */
export const usesToken = (): boolean => base !== "";

let unauthorized: (code: string) => void = () => undefined;

/** Who hears that the service asks to sign in or pick a profile first (lib/account). */
export function onUnauthorized(listener: (code: string) => void): void {
  unauthorized = listener;
}

/** One request to the service; its failure becomes a TagError with the service's code. */
async function api(path: string, init?: RequestInit): Promise<Response> {
  const token = usesToken() ? storedToken() : null;
  const headers = new Headers(init?.headers);
  if (token) headers.set("authorization", `Bearer ${token}`);
  const response = await fetch(`${base}/api/${path}`, { ...init, headers });
  if (!response.ok) {
    const failure: Failure = await response.json().catch(() => ({}));
    if (response.status === 401 && (failure.code === "signin" || failure.code === "profile")) {
      unauthorized(failure.code);
    }
    throw new TagError(failure.code ?? "io", failure.message ?? `${response.status} ${response.statusText}`);
  }
  return response;
}

/** A request to the service answered with JSON (lib/account, lib/people). */
export const serviceJson = <T>(path: string, init?: RequestInit): Promise<T> =>
  api(path, init).then(async (response) => (response.status === 204 ? (undefined as T) : ((await response.json()) as T)));

const json = serviceJson;

/** A POST with a JSON body. */
export const post = (body?: unknown): RequestInit => ({
  method: "POST",
  ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
});
const at = (root: string, path = ""): string => `root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`;

function serviceVfs(root: string, name: string): VFSAdapter {
  return {
    name,
    list: (path) => json<VFSListEntry[]>(`list?${at(root, path)}`),
    read: async (path) => new Uint8Array(await (await api(`read?${at(root, path)}`)).arrayBuffer()),
    write: async (path, data) => {
      await api(`write?${at(root, path)}`, { method: "POST", body: data as Uint8Array<ArrayBuffer> });
    },
    delete: async (path) => {
      await api(`delete?${at(root, path)}`, post());
    },
    rename: async (from, to) => {
      await api("rename", post({ root, from, to }));
    },
    stat: (path) => json<VFSStat | null>(`stat?${at(root, path)}`),
    mkdir: async (path) => {
      await api(`mkdir?${at(root, path)}`, post());
    }
  };
}

function serviceSource(root: string, name: string): RootSource {
  const vfs = serviceVfs(root, name);
  return {
    kind: "service",
    vfs,
    saved: root,
    walk: () => json(`walk?${at(root)}`),
    inspect: (path, known) => json<Inspection>("inspect", post({ root, path, known: known ?? null })),
    save: (path: string, previous: TrackMetadata, metadata: TrackMetadata) =>
      json<Inspection>("save", post({ root, path, previous, metadata })),
    async openMedia(path): Promise<MediaHandle> {
      const before = await vfs.stat(path);
      const grant = usesToken() ? `&t=${encodeURIComponent(await mediaToken())}` : "";
      return {
        url: `${base}/api/media?${at(root, path)}${grant}`,
        changed: async () => {
          const now = await vfs.stat(path);
          return now?.size !== before?.size || now?.mtime !== before?.mtime;
        },
        release: () => undefined,
        // The desktop app and its own service (S2) are on the same machine: its native player (E5)
        // opens the file by its path.
        native: usesToken() ? { root, path } : undefined
      };
    },
    close: () => void api("roots/close", post({ root })).catch(() => undefined)
  };
}

// ─── The family library (F1) ─────────────────────────────────────────────────

/** What the session keeps for the library: it is the service's own, not a path. */
export const LIBRARY = "@library";

const inLibrary = (path = ""): string => `path=${encodeURIComponent(path)}`;

/**
 * The family library as a root: songs by their places in it, small files beside them. A small
 * file is written with the size and date it was read at (F4), so a shared playlist changed since
 * is not written over (`stale`).
 */
function libraryVfs(name: string): VFSAdapter {
  const seen = new Map<string, { size: number; mtime: number }>();
  const stat = async (path: string): Promise<VFSStat | null> => {
    const found = await json<(VFSStat & { size: number; mtime: number }) | null>(`library/stat?${inLibrary(path)}`);
    if (found) seen.set(path, { size: found.size, mtime: found.mtime });
    return found;
  };
  return {
    name,
    list: (path) => json<VFSListEntry[]>(`library/list?${inLibrary(path)}`),
    read: async (path) => {
      const bytes = new Uint8Array(await (await api(`library/read?${inLibrary(path)}`)).arrayBuffer());
      await stat(path).catch(() => null);
      return bytes;
    },
    write: async (path, data) => {
      const read = seen.get(path);
      const version = read ? `&size=${read.size}&mtime=${read.mtime}` : "";
      await api(`library/write?${inLibrary(path)}${version}`, { method: "POST", body: data as Uint8Array<ArrayBuffer> });
      await stat(path).catch(() => null);
    },
    delete: async (path) => {
      await api(`library/delete?${inLibrary(path)}`, post());
    },
    rename: async (from, to) => {
      await api("library/rename", post({ from, to }));
    },
    stat,
    mkdir: async (path) => {
      await api(`library/mkdir?${inLibrary(path)}`, post());
    }
  };
}

/** The family library, when the service has one; null otherwise. */
export async function librarySource(): Promise<RootSource | null> {
  const info = await json<{ name: string }>("library").catch(() => null);
  if (!info) return null;
  const vfs = libraryVfs(info.name);
  return {
    kind: "library",
    vfs,
    saved: LIBRARY,
    walk: () => json("library/walk"),
    inspect: (path, known) => json<Inspection>("library/inspect", post({ path, known: known ?? null })),
    save: (path: string, previous: TrackMetadata, metadata: TrackMetadata, scope?: "family" | "mine", expected?: string) =>
      json<Inspection>("library/save", post({ path, previous, metadata, scope: scope ?? "family", expected })),
    async openMedia(path): Promise<MediaHandle> {
      const before = await vfs.stat(path);
      const grant = usesToken() ? `&t=${encodeURIComponent(await mediaToken())}` : "";
      return {
        url: `${base}/api/library/media?${inLibrary(path)}${grant}`,
        changed: async () => {
          const now = await vfs.stat(path);
          return now?.size !== before?.size || now?.mtime !== before?.mtime;
        },
        release: () => undefined
      };
    },
    close: () => undefined
  };
}

/** Where a song of the library is downloaded, with the family's tags. */
export async function libraryDownloadUrl(path: string): Promise<string> {
  const grant = usesToken() ? `&t=${encodeURIComponent(await mediaToken())}` : "";
  return `${base}/api/library/download?${inLibrary(path)}${grant}`;
}

/** Other tags brought with a song's audio (until F3 makes them someone's own). */
export type LibrarySuggestion = { fields: { title: string; artist: string; album: string; year: string; genre: string; track: string }; by: string; at: number };

export const librarySuggestions = (path: string): Promise<LibrarySuggestion[]> =>
  json<LibrarySuggestion[]>(`library/suggestions?${inLibrary(path)}`);

// ─── Each person's own (F3) ──────────────────────────────────────────────────

/** What a song's tags are made of: the file's, what the family's layer sets, what one's own sets. */
export type LayerJson = Partial<Record<"title" | "artist" | "album" | "year" | "genre" | "track", string>> & { cover?: { kind: string } };
export type SongLayers = {
  file: LibrarySuggestion["fields"];
  family: LayerJson;
  mine: LayerJson;
  suggestions: (LibrarySuggestion & { id: number })[];
  favourite: boolean;
};

export const songLayers = (path: string): Promise<SongLayers> => json<SongLayers>(`library/layers?${inLibrary(path)}`);
export const forgetMine = (path: string): Promise<void> => json("library/mine/forget", post({ path }));
export const setFavourite = (path: string, on: boolean): Promise<void> => json("library/favourite", post({ path, on }));
export const notePlayed = (path: string): Promise<void> => json("library/played", post({ path }));
export const clearHistory = (): Promise<void> => json("library/history/clear", post());
export const applySuggestion = (path: string, id: number): Promise<Inspection> => json<Inspection>("library/suggestions/apply", post({ path, id }));
export const readLibraryText = async (path: string): Promise<string> =>
  new TextDecoder().decode(await (await api(`library/read?${inLibrary(path)}`)).arrayBuffer());

/** A person's settings, kept with them on the service. */
export type MySettings = { theme: "light" | "dark" | null; language: string | null; mine: boolean };
export const saveMySettings = (change: Partial<MySettings>): Promise<MySettings> => json<MySettings>("me/settings", post(change));

/** What importing did. */
export type ImportReport = { added: number; existing: number; suggested: number; unreadable: [string, string][] };
export type ImportState = { running: boolean; name: string; done: number; total: number; report: ImportReport | null; error: string | null };

/** Starts importing a folder of the service's machine (owners). */
export const importFolder = (path: string): Promise<ImportState> => json<ImportState>("library/import", post({ path }));

/** The import under way, or the last one. */
export const importState = (): Promise<ImportState> => json<ImportState>("library/import");

/** One file uploaded to the library as `path`; what became of it. */
export const uploadToLibrary = (path: string, file: Blob): Promise<{ result: "added" | "existing" | "suggested" | "unreadable"; path?: string; why?: string }> =>
  json(`library/upload?${inLibrary(path)}`, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: file });

/** The desktop app's media token and when it is to be renewed (the service's lasts 12 hours). */
let mediaGrant: { t: string; until: number } | null = null;

async function mediaToken(): Promise<string> {
  if (!mediaGrant || mediaGrant.until < Date.now()) {
    const { t } = await json<{ t: string }>("media/token");
    mediaGrant = { t, until: Date.now() + 11 * 3600 * 1000 };
  }
  return mediaGrant.t;
}

type Opened = { path: string; name: string };

/** Opens a folder of the service's machine. */
export async function openServiceFolder(path: string): Promise<RootSource> {
  const opened = await json<Opened>("roots", post({ path }));
  return serviceSource(opened.path, opened.name);
}

/** Reopens a folder the session kept: as it is if the service has it open, else opened again (an owner's); null when it is gone. */
export async function restoreServiceSource(path: string): Promise<RootSource | null> {
  if (path === LIBRARY) return librarySource();
  const open = await json<Opened[]>("roots").catch(() => [] as Opened[]);
  const found = open.find((opened) => opened.path === path);
  return found ? serviceSource(found.path, found.name) : openServiceFolder(path).catch(() => null);
}

/** The folders the service has open (an owner opened them), as sources: what someone who may not open folders sees (S3). */
export async function serviceRoots(): Promise<RootSource[]> {
  const library = await librarySource();
  const open = await json<Opened[]>("roots");
  return [...(library ? [library] : []), ...open.map((opened) => serviceSource(opened.path, opened.name))];
}

/** One folder of the service's machine, for the dialog: its subfolders and its parent. */
export type MachineFolder = { path: string; parent: string | null; folders: { name: string; path: string }[] };

/** The folders in a folder of the service's machine; its home when no path is given. */
export function machineFolder(path?: string): Promise<MachineFolder> {
  return json<MachineFolder>(path === undefined ? "folders" : `folders?path=${encodeURIComponent(path)}`);
}
