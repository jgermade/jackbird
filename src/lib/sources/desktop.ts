// A root in the desktop app (Tauri v2): a folder by its path, its files
// reached through the app's own commands (src-tauri/src/lib.rs, over
// crates/core). The tags and checksums are worked out on the Rust side, by
// path: no file's bytes cross to the webview to be read or hashed, only small
// files (`.meta/`, playlists) do. Playback comes from the asset protocol
// (macOS, Windows) or the app's local server (Linux). See
// RECORD/2026-08-11.musikmatch-rust-migration.WIP.md (E4-D1 to E4-D6).

import type { VFSAdapter, VFSListEntry, VFSStat } from "@cloudauthn/vfs-sync";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import type { Inspection, MediaHandle, RootSource, TrackMetadata } from "../../types";
import { TagError } from "../tags";

/** An error as the app's commands give it. */
type Failure = { code: string; message: string };

/** Calls a command; its failure becomes a TagError with the same code, so the interface says why. */
async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    const failure = error as Partial<Failure>;
    throw new TagError(failure.code ?? "io", failure.message ?? String(error));
  }
}

type InspectionJson = Omit<Inspection, "lastModified"> & { lastModified: number };
type MediaUrl = { kind: "asset"; path: string } | { kind: "http"; url: string };

/** The small-file adapter over the app's commands. */
function desktopVfs(root: string, name: string): VFSAdapter {
  return {
    name,
    list: (path) => call<VFSListEntry[]>("list", { root, path }),
    read: async (path) => new Uint8Array(await call<ArrayBuffer>("read", { root, path })),
    write: async (path, data) => {
      try {
        await invoke("write", data, { headers: { "x-root": encodeURIComponent(root), "x-path": encodeURIComponent(path) } });
      } catch (error) {
        const failure = error as Partial<Failure>;
        throw new TagError(failure.code ?? "io", failure.message ?? String(error));
      }
    },
    delete: (path) => call<void>("delete", { root, path }),
    rename: (from, to) => call<void>("rename", { root, from, to }),
    stat: (path) => call<VFSStat | null>("stat", { root, path }),
    mkdir: (path) => call<void>("mkdir", { root, path })
  };
}

/** A root over a path the app has opened. */
function desktopSource(root: string, name: string): RootSource {
  return {
    kind: "desktop",
    vfs: desktopVfs(root, name),
    saved: root,
    walk: () => call("walk", { root }),
    inspect: (path, known) => call<InspectionJson>("inspect", { root, path, known: known ?? null }),
    save: (path: string, previous: TrackMetadata, metadata: TrackMetadata) =>
      call<InspectionJson>("save", { root, path, previous, metadata }),
    async openMedia(path): Promise<MediaHandle> {
      const found = await call<MediaUrl>("media_url", { root, path });
      const before = await call<VFSStat | null>("stat", { root, path });
      return {
        url: found.kind === "asset" ? convertFileSrc(found.path) : found.url,
        changed: async () => {
          const now = await call<VFSStat | null>("stat", { root, path });
          return now?.size !== before?.size || now?.mtime !== before?.mtime;
        },
        release: () => undefined,
        native: { root, path }
      };
    },
    close: () => void invoke("close_root", { root }).catch(() => undefined)
  };
}

type Opened = { path: string; name: string };

/** Asks for a folder in the system's dialog; null when the person cancels. */
export async function pickDesktopSource(): Promise<RootSource | null> {
  const opened = await call<Opened | null>("pick_folder");
  return opened ? desktopSource(opened.path, opened.name) : null;
}

/** Reopens a folder the session kept; null when it is gone. */
export async function restoreDesktopSource(path: string): Promise<RootSource | null> {
  const opened = await call<Opened>("open_root", { path }).catch(() => null);
  return opened ? desktopSource(opened.path, opened.name) : null;
}
