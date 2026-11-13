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
import { isLoopbackAddress, savedOnServer } from "../../helpers/instance";
import { TagError } from "../tags";

type Failure = { code?: string; message?: string };

/**
 * One server and the way to it (E6b-D11): its address (empty: the page's own origin), the session's
 * token kept for it (the apps reach a server from another origin, so they send a bearer; the page
 * served by it has a cookie instead), and its media token. A root holds the client of its server.
 */
export type ServiceClient = {
  /** Its address, `https://music.example.org`; empty: the page's own origin. */
  readonly address: string;
  /** Whether sessions travel as a bearer token (any server but the page's own origin). */
  readonly usesToken: boolean;
  setToken(token: string | null): void;
  api(path: string, init?: RequestInit): Promise<Response>;
  json<T>(path: string, init?: RequestInit): Promise<T>;
  mediaToken(): Promise<string>;
};

const TOKEN_KEY = "jackbird.serviceToken";

const readKey = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

const writeKey = (key: string, value: string | null): void => {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    // Without storage, the app signs in again next time.
  }
};

let unauthorized: (code: string, client: ServiceClient) => void = () => undefined;

/** Who hears that a server asks to sign in or pick a profile first (lib/account). */
export function onUnauthorized(listener: (code: string, client: ServiceClient) => void): void {
  unauthorized = listener;
}

const clients = new Map<string, ServiceClient>();
/** The home server's address: the one the page started with, whose token was kept before E6b under TOKEN_KEY. */
let home = "";

function makeClient(address: string): ServiceClient {
  const key = `${TOKEN_KEY}:${address}`;
  /** The media token and when it is to be renewed (the service's lasts 12 hours). */
  let grant: { t: string; until: number } | null = null;
  const client: ServiceClient = {
    address,
    usesToken: address !== "",
    setToken(token) {
      grant = null;
      writeKey(key, token);
      if (address === home) writeKey(TOKEN_KEY, null);
    },
    async api(path, init) {
      const token = client.usesToken ? (readKey(key) ?? (address === home ? readKey(TOKEN_KEY) : null)) : null;
      const headers = new Headers(init?.headers);
      if (token) headers.set("authorization", `Bearer ${token}`);
      const response = await fetch(`${address}/api/${path}`, { ...init, headers });
      if (!response.ok) {
        const failure: Failure = await response.json().catch(() => ({}));
        if (response.status === 401 && (failure.code === "signin" || failure.code === "profile")) {
          unauthorized(failure.code, client);
        }
        throw new TagError(failure.code ?? "io", failure.message ?? `${response.status} ${response.statusText}`);
      }
      return response;
    },
    json: <T>(path: string, init?: RequestInit): Promise<T> =>
      client.api(path, init).then(async (response) => (response.status === 204 ? (undefined as T) : ((await response.json()) as T))),
    async mediaToken() {
      if (!grant || grant.until < Date.now()) {
        const { t } = await client.json<{ t: string }>("media/token");
        grant = { t, until: Date.now() + 11 * 3600 * 1000 };
      }
      return grant.t;
    }
  };
  return client;
}

/** The client of the server at `address` (empty: the page's own origin), one per address. */
export function serviceAt(address: string): ServiceClient {
  const clean = address.replace(/\/$/, "");
  let client = clients.get(clean);
  if (!client) {
    client = makeClient(clean);
    clients.set(clean, client);
  }
  return client;
}

/**
 * The server the account, people and the family library's own features speak to: the home one
 * when the page starts, then the server of the root in front (lib/account's `followServer`).
 */
let current = serviceAt("");

/** The server the account and the library's features speak to now. */
export const currentServer = (): ServiceClient => current;

/** Speaks to `client` from now on (the root in front is on it). */
export function useServer(client: ServiceClient): void {
  current = client;
}

/** The home server: asked at this address (`http://127.0.0.1:4646`) instead of the page's own origin. */
export function useServiceAt(address: string): void {
  home = address.replace(/\/$/, "");
  current = serviceAt(home);
}

/** The home server's client: the page's own origin, the desktop's installed service, or a phone's first instance. */
export const homeServer = (): ServiceClient => serviceAt(home);

/** Whether a server is the home one, whose roots the session keeps by their path alone. */
const isHome = (client: ServiceClient): boolean => client.address === home;

/** Keeps (or forgets) the session token of the server spoken to now. */
export function setServiceToken(token: string | null): void {
  current.setToken(token);
}

/** Whether sessions with the server spoken to now travel as a bearer token. */
export const usesToken = (): boolean => current.usesToken;

/** A request to the server spoken to now, answered with JSON (lib/account, lib/people). */
export const serviceJson = <T>(path: string, init?: RequestInit): Promise<T> => current.json<T>(path, init);

const json = serviceJson;

/** A POST with a JSON body. */
export const post = (body?: unknown): RequestInit => ({
  method: "POST",
  ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
});
const at = (root: string, path = ""): string => `root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`;

function serviceVfs(client: ServiceClient, root: string, name: string): VFSAdapter {
  const { api, json } = client;
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

function serviceSource(client: ServiceClient, root: string, name: string): RootSource {
  const vfs = serviceVfs(client, root, name);
  const { api, json } = client;
  return {
    kind: "service",
    vfs,
    saved: savedOnServer(isHome(client) ? null : client.address, root),
    server: client,
    walk: () => json(`walk?${at(root)}`),
    inspect: (path, known) => json<Inspection>("inspect", post({ root, path, known: known ?? null })),
    save: (path: string, previous: TrackMetadata, metadata: TrackMetadata) =>
      json<Inspection>("save", post({ root, path, previous, metadata })),
    async openMedia(path): Promise<MediaHandle> {
      const before = await vfs.stat(path);
      const grant = client.usesToken ? `&t=${encodeURIComponent(await client.mediaToken())}` : "";
      return {
        url: `${client.address}/api/media?${at(root, path)}${grant}`,
        changed: async () => {
          const now = await vfs.stat(path);
          return now?.size !== before?.size || now?.mtime !== before?.mtime;
        },
        release: () => undefined,
        // The desktop app and its own service (S2) are on the same machine: its native player (E5)
        // opens the file by its path.
        native: client.usesToken && isLoopbackAddress(client.address) ? { root, path } : undefined
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
function libraryVfs(client: ServiceClient, name: string): VFSAdapter {
  const { api, json } = client;
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
      const bytes = new Uint8Array(await (await current.api(`library/read?${inLibrary(path)}`)).arrayBuffer());
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

/** The family library of a server (the one spoken to now unless given), when it has one; null otherwise. */
export async function librarySource(client: ServiceClient = current): Promise<RootSource | null> {
  const { json } = client;
  const info = await json<{ name: string }>("library").catch(() => null);
  if (!info) return null;
  const vfs = libraryVfs(client, info.name);
  return {
    kind: "library",
    vfs,
    saved: savedOnServer(isHome(client) ? null : client.address, LIBRARY),
    server: client,
    walk: () => json("library/walk"),
    inspect: (path, known) => json<Inspection>("library/inspect", post({ path, known: known ?? null })),
    save: (path: string, previous: TrackMetadata, metadata: TrackMetadata, scope?: "family" | "mine", expected?: string) =>
      json<Inspection>("library/save", post({ path, previous, metadata, scope: scope ?? "family", expected })),
    async openMedia(path): Promise<MediaHandle> {
      const before = await vfs.stat(path);
      const grant = client.usesToken ? `&t=${encodeURIComponent(await client.mediaToken())}` : "";
      return {
        url: `${client.address}/api/library/media?${inLibrary(path)}${grant}`,
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
  const grant = current.usesToken ? `&t=${encodeURIComponent(await current.mediaToken())}` : "";
  return `${current.address}/api/library/download?${inLibrary(path)}${grant}`;
}

/** Other tags brought with a song's audio (until F3 makes them someone's own). */
export type LibrarySuggestion = {
  fields: { title: string; artist: string; album: string; year: string; genre: string; track: string; disc?: string; album_artist?: string; compilation?: string };
  by: string;
  at: number;
};

export const librarySuggestions = (path: string): Promise<LibrarySuggestion[]> =>
  json<LibrarySuggestion[]>(`library/suggestions?${inLibrary(path)}`);

// ─── Each person's own (F3) ──────────────────────────────────────────────────

/** What a song's tags are made of: the file's, what the family's layer sets, what one's own sets. */
export type LayerJson = Partial<Record<"title" | "artist" | "album" | "year" | "genre" | "track" | "disc" | "album_artist" | "compilation", string>> & { cover?: { kind: string } };
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
/** A play of a song of a server's library (F3), counted on that server (the one spoken to now unless given). */
export const notePlayed = (path: string, client: ServiceClient = current): Promise<void> => client.json("library/played", post({ path }));
export const clearHistory = (): Promise<void> => json("library/history/clear", post());
export const applySuggestion = (path: string, id: number): Promise<Inspection> => json<Inspection>("library/suggestions/apply", post({ path, id }));
export const readLibraryText = async (path: string): Promise<string> =>
  new TextDecoder().decode(await (await current.api(`library/read?${inLibrary(path)}`)).arrayBuffer());

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

type Opened = { path: string; name: string };

/** Opens a folder of a server's machine (the one spoken to now unless given). */
export async function openServiceFolder(path: string, client: ServiceClient = current): Promise<RootSource> {
  const opened = await client.json<Opened>("roots", post({ path }));
  return serviceSource(client, opened.path, opened.name);
}

/** Reopens a folder the session kept: as it is if the server has it open, else opened again (an owner's); null when it is gone. */
export async function restoreServiceSource(path: string, client: ServiceClient = current): Promise<RootSource | null> {
  if (path === LIBRARY) return librarySource(client);
  const open = await client.json<Opened[]>("roots").catch(() => [] as Opened[]);
  const found = open.find((opened) => opened.path === path);
  return found ? serviceSource(client, found.path, found.name) : openServiceFolder(path, client).catch(() => null);
}

/** The folders a server has open (an owner opened them), as sources: what someone who may not open folders sees (S3). */
export async function serviceRoots(client: ServiceClient = current): Promise<RootSource[]> {
  const library = await librarySource(client);
  const open = await client.json<Opened[]>("roots");
  return [...(library ? [library] : []), ...open.map((opened) => serviceSource(client, opened.path, opened.name))];
}

/** One folder of the service's machine, for the dialog: its subfolders and its parent. */
export type MachineFolder = { path: string; parent: string | null; folders: { name: string; path: string }[] };

/** The folders in a folder of the service's machine; its home when no path is given. */
export function machineFolder(path?: string): Promise<MachineFolder> {
  return json<MachineFolder>(path === undefined ? "folders" : `folders?path=${encodeURIComponent(path)}`);
}
