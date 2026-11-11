// The phone's own storage as a library's source (E6b-D9): "All files access" asked of Android
// (crates/player's Kotlin side), then its folders listed by the app (`device_folders`) for the
// folder chooser (lib/folders.ts). The folder chosen opens as on a computer (./sources/desktop).
// See RECORD/2026-08-11.musikmatch-rust-migration.WIP.md (2026-11-11 22:47).

import { invoke } from "@tauri-apps/api/core";
import type { MachineFolder } from "./sources/service";

const PLUGIN = "plugin:jackbird-player";

const granted = (): Promise<boolean> =>
  invoke<{ granted: boolean }>(`${PLUGIN}|storage_access`).then(
    (answer) => answer.granted,
    () => false
  );

/** Resolves once the page is in front again (the person comes back from Android's settings). */
const back = (): Promise<void> =>
  new Promise((resolve) => {
    const shown = () => {
      if (document.hidden) return;
      document.removeEventListener("visibilitychange", shown);
      resolve();
    };
    document.addEventListener("visibilitychange", shown);
  });

/**
 * Whether the app may read the phone's storage: asked for when it may not (Android's own page for
 * it, or its dialog before Android 11), then asked again once the person is back. Up to two minutes.
 */
export async function ensureStorageAccess(): Promise<boolean> {
  if (await granted()) return true;
  const returned = back();
  await invoke(`${PLUGIN}|ask_storage_access`).catch(() => undefined);
  await Promise.race([returned, new Promise((resolve) => setTimeout(resolve, 120_000))]);
  // The dialog of Android 10 and before settles without leaving the page: a moment for it.
  for (let step = 0; step < 20 && !(await granted()); step += 1) await new Promise((resolve) => setTimeout(resolve, 500));
  return granted();
}

/** The folders in a folder of the phone's storage (its top when none is given). */
export const deviceFolders = (path?: string): Promise<MachineFolder> => invoke<MachineFolder>("device_folders", { path: path ?? null });
