// The dialog that chooses a folder of the machine the service runs on (S1-D5,
// the owner's choice: any folder the person can read, from their home):
// `chooseMachineFolder()` opens it and resolves with the folder chosen, or
// null when it is cancelled. Its view is views/folder-dialog.html.

import { $reactive } from "jq79";
import { machineFolder, type MachineFolder } from "./sources/service";

export const folderPicker = $reactive({
  open: false,
  busy: false,
  error: "",
  here: null as MachineFolder | null
});

let settle: ((path: string | null) => void) | null = null;

/** Shows a folder's subfolders; on failure, says why and stays where it was. */
export async function enterFolder(path?: string): Promise<void> {
  folderPicker.busy = true;
  folderPicker.error = "";
  try {
    folderPicker.here = await machineFolder(path);
  } catch (error) {
    folderPicker.error = error instanceof Error ? error.message : String(error);
  } finally {
    folderPicker.busy = false;
  }
}

/** Opens the dialog at the person's home; the folder chosen, or null. */
export function chooseMachineFolder(): Promise<string | null> {
  settle?.(null);
  folderPicker.open = true;
  folderPicker.here = null;
  void enterFolder();
  return new Promise((resolve) => {
    settle = resolve;
  });
}

function finish(path: string | null): void {
  folderPicker.open = false;
  settle?.(path);
  settle = null;
}

/** Chooses the folder shown. */
export function chooseThisFolder(): void {
  if (folderPicker.here) {
    finish(folderPicker.here.path);
  }
}

/** Closes the dialog without a folder. */
export function cancelFolderChoice(): void {
  finish(null);
}
