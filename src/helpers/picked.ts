// A folder in a browser with no File System Access (Safari, Firefox): how much of it this browser
// can reach, and the folder as the file input hands it over (every file under it, each named by its
// path from the chosen folder's own name). See lib/sources/picked.ts.

/** What a browser can do with a folder: read and write it, only read it, or not open one at all. */
export type FolderAccess = "full" | "read" | "none";

/** What the browser has: the File System Access picker, a folder file input, and whether it is a phone or tablet. */
export type FolderAbilities = { picker: boolean; folderInput: boolean; handheld: boolean };

/**
 * The picker reads and writes; a folder file input only reads (and on a phone or tablet it is
 * there but chooses no folder); with neither, no folder opens.
 */
export function folderAccess({ picker, folderInput, handheld }: FolderAbilities): FolderAccess {
  if (picker) return "full";
  return folderInput && !handheld ? "read" : "none";
}

/** Whether a user agent is a phone's or a tablet's (an iPad asks for the desktop site as a Mac: its touch gives it away). */
export function isHandheld(agent: string, touchPoints: number): boolean {
  return /Android|iPhone|iPad|iPod/i.test(agent) || (/Macintosh/.test(agent) && touchPoints > 1);
}

/**
 * One of the input's files by its relative path ("Music/Album/01.mp3"): the chosen folder's name,
 * the first part, and the path under it ("Album/01.mp3"). Null for a path with no folder.
 */
export function splitPicked(relativePath: string): { folder: string; path: string } | null {
  const parts = relativePath.split("/").filter(Boolean);
  return parts.length < 2 ? null : { folder: parts[0], path: parts.slice(1).join("/") };
}
