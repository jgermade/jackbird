// A root on the phone (E6b-D9): a folder the person chose in Android's folder picker, which grants
// the app that folder alone. It is kept by its `content://` address. Its files are reached through
// the app's plugin by their paths in the folder (crates/player, Folders.kt); their tags and
// checksums are worked out by Rust (`phone_inspect`) on the file the plugin opens for it, streamed, so no
// song's bytes cross to the page. The player plays each file by its `content://` address. Saving
// tags waits for E6b-D9's second part. See RECORD/2026-08-11.musikmatch-rust-migration.WIP.md
// (2026-11-11 23:33 and after).

import type { VFSAdapter, VFSListEntry, VFSStat, WalkedFile } from "@cloudauthn/vfs-sync";
import { invoke } from "@tauri-apps/api/core";
import type { Inspection, MediaHandle, RootSource } from "../../types";
import { t } from "../i18n";
import { TagError } from "../tags";

const PLUGIN = "plugin:jackbird-player";

/** Calls one of the plugin's folder commands (or the app's); its failure becomes a TagError, so the interface says why. */
async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command.includes("|") || command === "phone_inspect" ? command : `${PLUGIN}|${command}`, args);
  } catch (error) {
    const failure = (typeof error === "object" && error ? error : { message: String(error) }) as { code?: string; message?: string };
    throw new TagError(failure.code ?? "io", failure.message ?? String(error));
  }
}

/** Bytes as base64 and back: small files cross the plugin's JSON so. */
function toBase64(bytes: Uint8Array): string {
  let text = "";
  for (let at = 0; at < bytes.length; at += 0x8000) text += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(text);
}

function fromBase64(data: string): Uint8Array<ArrayBuffer> {
  const text = atob(data);
  const bytes = new Uint8Array(text.length);
  for (let at = 0; at < text.length; at += 1) bytes[at] = text.charCodeAt(at);
  return bytes;
}

type InspectionJson = Omit<Inspection, "lastModified"> & { lastModified: number };

function phoneVfs(tree: string, name: string): VFSAdapter {
  return {
    name,
    list: async (path) => (await call<{ entries: VFSListEntry[] }>("folder_list", { tree, path })).entries,
    read: async (path) => fromBase64((await call<{ data: string }>("folder_read", { tree, path })).data),
    write: async (path, data) => {
      await call("folder_write", { tree, path, data: toBase64(data as Uint8Array) });
    },
    delete: async (path) => {
      await call("folder_delete", { tree, path });
    },
    rename: async (from, to) => {
      await call("folder_rename", { tree, from, to });
    },
    stat: async (path) => (await call<{ stat?: VFSStat | null }>("folder_stat", { tree, path })).stat ?? null,
    mkdir: async (path) => {
      await call("folder_mkdir", { tree, path });
    }
  };
}

function phoneSource(tree: string, name: string): RootSource {
  const vfs = phoneVfs(tree, name);
  return {
    kind: "desktop",
    vfs,
    saved: tree,
    walk: async () => (await call<{ files: WalkedFile[] }>("folder_walk", { tree })).files,
    inspect: (path, known) => call<InspectionJson>("phone_inspect", { tree, path, known: known ?? null }),
    save: async () => {
      throw new TagError("unsupported", t("sources.phoneSaveSoon"));
    },
    async openMedia(path): Promise<MediaHandle> {
      const { address } = await call<{ address: string }>("folder_address", { tree, path });
      const before = await vfs.stat(path);
      return {
        url: address,
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

/** Whether a kept root is a phone's folder (its `content://` address). */
export const isPhoneFolder = (saved: string): boolean => saved.startsWith("content://");

/** Android's folder picker (opening at `initial`, a folder's address, if given): the folder chosen, as a root; null when the person cancels. */
export async function pickPhoneFolder(initial?: string): Promise<RootSource | null> {
  const picked = await call<{ tree?: string | null; name?: string }>("pick_folder", { initial: initial ?? null });
  return picked.tree ? phoneSource(picked.tree, picked.name ?? "") : null;
}

/** Reopens a folder kept from before, while the app still holds its permission; null otherwise. */
export async function restorePhoneFolder(tree: string): Promise<RootSource | null> {
  const found = await call<{ name: string }>("folder_check", { tree }).catch(() => null);
  return found ? phoneSource(tree, found.name) : null;
}
