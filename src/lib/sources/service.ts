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
        release: () => undefined
      };
    },
    close: () => void api("roots/close", post({ root })).catch(() => undefined)
  };
}

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
  const open = await json<Opened[]>("roots").catch(() => [] as Opened[]);
  const found = open.find((opened) => opened.path === path);
  return found ? serviceSource(found.path, found.name) : openServiceFolder(path).catch(() => null);
}

/** The folders the service has open (an owner opened them), as sources: what someone who may not open folders sees (S3). */
export async function serviceRoots(): Promise<RootSource[]> {
  const open = await json<Opened[]>("roots");
  return open.map((opened) => serviceSource(opened.path, opened.name));
}

/** One folder of the service's machine, for the dialog: its subfolders and its parent. */
export type MachineFolder = { path: string; parent: string | null; folders: { name: string; path: string }[] };

/** The folders in a folder of the service's machine; its home when no path is given. */
export function machineFolder(path?: string): Promise<MachineFolder> {
  return json<MachineFolder>(path === undefined ? "folders" : `folders?path=${encodeURIComponent(path)}`);
}
