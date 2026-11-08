// Playlists: each root's playlist files, read when its folder is walked, and
// what the library does with them: make one (from tracks, or from the
// queue), add to one, move and take out its entries, delete one. They go
// through one interface (PlaylistStore), so the views do not know where a
// playlist lives: in a folder, local or in the cloud, it is a `.m3u8` file
// (m3uPlaylists); on the family instance it will be rows of its database (F1,
// F3). Reading and writing M3U is helpers/m3u.ts; the entries' changes are
// helpers/playlists.ts. See RECORD/2026-11-04.github-actions-workflows.WIP.md
// (22:00, 22:12 and W8's plan).

import type { VFSAdapter } from "@cloudauthn/vfs-sync";
import { $reactive, $toRaw } from "jq79";
import { isAudioFile } from "../helpers/formats";
import { parseM3u, playlistName, serializeM3u } from "../helpers/m3u";
import {
  decodePlaylist,
  entryFor,
  isPlaylistFile,
  moveEntry,
  newPlaylistPath,
  pathTaken,
  renamedEntries,
  withPlaylist,
  withoutEntry
} from "../helpers/playlists";
import type { Playlist, PlaylistEntry, RootWorkspace } from "../types";
import { t, tn } from "./i18n";
import { library } from "./library";
import { playback } from "./playback";
import { updateRoots } from "./roots";
import { ui, type PlaylistDialog } from "./ui";

/** Where a root's playlists live. The actions below use only this. */
export type PlaylistStore = {
  /** The playlists among `files`, the files the root's walk found. */
  list(files: readonly string[]): Promise<Playlist[]>;
  /** Whether anything is at `path` (a file the library does not list, say). */
  exists(path: string): Promise<boolean>;
  /** Writes a playlist, making it when it is new. */
  save(playlist: Playlist): Promise<void>;
  delete(path: string): Promise<void>;
};

/**
 * A folder's playlists as M3U files: `.m3u8` and `.m3u` read (a file that
 * cannot be read is left out, and logged); a playlist written as UTF-8 text,
 * which is what `.m3u8` is (a `.m3u` jackbird changes is written so too).
 */
export function m3uPlaylists(vfs: VFSAdapter): PlaylistStore {
  return {
    async list(files) {
      const found: Playlist[] = [];
      // What a path written outside the folder (VLC's absolute ones) may be.
      const audio = files.filter(isAudioFile);
      for (const path of files.filter(isPlaylistFile)) {
        try {
          const text = decodePlaylist(await vfs.read(path), path);
          found.push({ path, name: playlistName(path), entries: parseM3u(text, path, audio) });
        } catch (error) {
          console.error(`jackbird: could not read the playlist ${path}`, error);
        }
      }
      return found;
    },
    async exists(path) {
      return (await vfs.stat(path)) !== null;
    },
    async save(playlist) {
      await vfs.write(playlist.path, new TextEncoder().encode(serializeM3u(playlist.entries, playlist.path)));
    },
    async delete(path) {
      await vfs.delete(path);
    }
  };
}

const storeOf = (root: RootWorkspace): PlaylistStore => m3uPlaylists(root.vfs);

function rootOf(rootId: string): RootWorkspace | null {
  return $toRaw(library).roots.find((root) => root.id === rootId) ?? null;
}

function setPlaylists(rootId: string, update: (playlists: Playlist[]) => Playlist[]): void {
  updateRoots((roots) => roots.map((root) => (root.id === rootId ? { ...root, playlists: update(root.playlists ?? []) } : root)));
}

const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

// Writes go one after another, in the order the playlists changed, so the
// last one written is the playlist as the library has it. It never rejects.
let writing: Promise<unknown> = Promise.resolve();

/** Writes a playlist after the writes before it; says so when it fails. Resolves to whether it went. */
function write(root: RootWorkspace, playlist: Playlist): Promise<boolean> {
  const done = writing
    .then(() => storeOf(root).save(playlist))
    .then(
      () => true,
      (error: unknown) => {
        library.errorMessage = t("message.playlistFailed", { name: playlist.name, reason: reasonOf(error) });
        return false;
      }
    );
  writing = done;
  return done;
}

/** Reads a root's playlists among the files its walk found. */
export async function loadPlaylists(rootId: string, files: readonly string[]): Promise<void> {
  const root = rootOf(rootId);
  if (!root) {
    return;
  }
  const playlists = await storeOf(root).list(files);
  setPlaylists(rootId, () => playlists);
}

/** Why a new playlist's name cannot be used in a root, as the dialog says it; null when it can. */
export function nameProblem(rootId: string, name: string): string | null {
  const path = newPlaylistPath(name);
  if (!path) {
    return t("playlist.nameEmpty");
  }
  const taken = (rootOf(rootId)?.playlists ?? []).map((playlist) => playlist.path);
  return pathTaken(path, taken) ? t("playlist.nameTaken") : null;
}

/** The entries for tracks of a root, in the order given (a track given twice is in it twice). */
function entriesOf(root: RootWorkspace, trackIds: readonly string[]): PlaylistEntry[] {
  const byId = new Map(root.tracks.map((track) => [track.id, track]));
  return trackIds.flatMap((id) => {
    const track = byId.get(id);
    return track ? [entryFor(track)] : [];
  });
}

/**
 * Makes a playlist named `name` in a root, holding its tracks `trackIds`, at
 * `Playlists/<name>.m3u8`: refused when the name is empty or taken (by a
 * playlist, or by any file there). Resolves to why not, or null when made.
 */
export async function createPlaylist(rootId: string, name: string, trackIds: readonly string[]): Promise<string | null> {
  const root = rootOf(rootId);
  const path = newPlaylistPath(name);
  const problem = nameProblem(rootId, name);
  if (!root || !path || problem) {
    return problem ?? t("playlist.nameEmpty");
  }
  try {
    if (await storeOf(root).exists(path)) {
      return t("playlist.nameTaken");
    }
  } catch (error) {
    return reasonOf(error);
  }
  const playlist: Playlist = { path, name: playlistName(path), entries: entriesOf(root, trackIds) };
  setPlaylists(rootId, (playlists) => withPlaylist(playlists, playlist));
  if (!(await write(root, playlist))) {
    setPlaylists(rootId, (playlists) => playlists.filter((one) => one.path !== path));
    return library.errorMessage;
  }
  library.errorMessage = null;
  library.infoMessage = tn("message.playlistMade", playlist.entries.length, { name: playlist.name });
  return null;
}

/** Changes a playlist's entries, then writes it. Resolves to whether it went. */
function change(rootId: string, path: string, update: (entries: PlaylistEntry[]) => PlaylistEntry[]): Promise<boolean> {
  const root = rootOf(rootId);
  const playlist = root?.playlists.find((one) => one.path === path);
  if (!root || !playlist) {
    return Promise.resolve(false);
  }
  const next = { ...playlist, entries: update(playlist.entries) };
  setPlaylists(rootId, (playlists) => withPlaylist(playlists, next));
  return write(root, next);
}

/** Adds tracks of a root to the end of one of its playlists. */
export async function addToPlaylist(rootId: string, path: string, trackIds: readonly string[]): Promise<boolean> {
  const root = rootOf(rootId);
  const playlist = root?.playlists.find((one) => one.path === path);
  if (!root || !playlist) {
    return false;
  }
  const added = entriesOf(root, trackIds);
  if (!(await change(rootId, path, (entries) => [...entries, ...added]))) {
    return false;
  }
  library.infoMessage = tn("message.addedToPlaylist", added.length, { name: playlist.name });
  return true;
}

/** Moves a playlist's entry from `from` to `to`. */
export function moveInPlaylist(rootId: string, path: string, from: number, to: number): Promise<boolean> {
  return change(rootId, path, (entries) => moveEntry(entries, from, to));
}

/** Takes the entry at `index` out of a playlist (its file stays where it is). */
export function removeFromPlaylist(rootId: string, path: string, index: number): Promise<boolean> {
  return change(rootId, path, (entries) => withoutEntry(entries, index));
}

/** Deletes a playlist (its file; its tracks stay). */
export async function deletePlaylist(rootId: string, path: string): Promise<boolean> {
  const root = rootOf(rootId);
  const playlist = root?.playlists.find((one) => one.path === path);
  if (!root || !playlist) {
    return false;
  }
  try {
    await writing;
    await storeOf(root).delete(path);
  } catch (error) {
    library.errorMessage = t("message.playlistFailed", { name: playlist.name, reason: reasonOf(error) });
    return false;
  }
  setPlaylists(rootId, (playlists) => playlists.filter((one) => one.path !== path));
  library.errorMessage = null;
  library.infoMessage = t("message.playlistDeleted", { name: playlist.name });
  return true;
}

/**
 * How many of the queue's tracks are in a root, and how many in others
 * (which a playlist there cannot hold: a `.m3u8` points at files under its
 * own folder). Read by the dialog, so it follows the queue.
 */
export function queueSplit(rootId: string): { inRoot: number; elsewhere: number } {
  const items = playback.queue?.items ?? [];
  const inRoot = items.filter((item) => item.rootId === rootId).length;
  return { inRoot, elsewhere: items.length - inRoot };
}

/** Saves the queue's tracks of a root, in its order, as a new playlist there. Resolves to why not, or null. */
export function saveQueueAsPlaylist(rootId: string, name: string): Promise<string | null> {
  const items = $toRaw(playback).queue?.items ?? [];
  return createPlaylist(
    rootId,
    name,
    items.filter((item) => item.rootId === rootId).map((item) => item.trackId)
  );
}

/** The playlist dialog's form: the name typed, the root it is for, why it failed, and whether it is working. */
export const playlistForm = $reactive({ name: "", rootId: "", error: "", busy: false });

/**
 * Opens the playlist dialog. Saving the queue, the folder offered is the one
 * of the track playing, else the active one.
 */
export function openPlaylistDialog(dialog: PlaylistDialog): void {
  const { queue } = $toRaw(playback);
  const playing = queue?.items[$toRaw(playback).index]?.rootId;
  playlistForm.name = "";
  playlistForm.error = "";
  playlistForm.busy = false;
  playlistForm.rootId = dialog.mode === "queue" ? (playing ?? $toRaw(library).activeRootId ?? "") : dialog.rootId;
  ui.playlist = dialog;
}

export function closePlaylistDialog(): void {
  ui.playlist = null;
}

/** The dialog's heading, by what it asks. */
export function playlistTitle(): string {
  const dialog = ui.playlist;
  if (!dialog) {
    return "";
  }
  if (dialog.mode === "add") {
    return t("playlist.addTitle");
  }
  return dialog.mode === "queue" ? t("playlist.queueTitle") : t("playlist.deleteTitle", { name: dialog.name });
}

/** Why the name typed cannot be used, once something is typed ("" when it can). */
export function playlistProblem(): string {
  const name = playlistForm.name;
  return name.trim() ? (nameProblem(playlistForm.rootId, name) ?? "") : "";
}

/** Whether the dialog's main key can run: deleting, or a usable name in an open folder. */
export function playlistReady(): boolean {
  const dialog = ui.playlist;
  if (!dialog || playlistForm.busy) {
    return false;
  }
  if (dialog.mode === "delete") {
    return true;
  }
  return !!playlistForm.name.trim() && !playlistProblem() && library.roots.some((root) => root.id === playlistForm.rootId);
}

/** Runs what the dialog asks: one of the others, then closes it, or says why not. */
async function run(action: () => Promise<string | null>): Promise<void> {
  if (playlistForm.busy) {
    return;
  }
  playlistForm.busy = true;
  playlistForm.error = "";
  const problem = await action();
  playlistForm.busy = false;
  if (problem) {
    playlistForm.error = problem;
  } else {
    closePlaylistDialog();
  }
}

/** The dialog's main key: make the playlist named (with the tracks, or from the queue), or delete the one asked about. */
export function submitPlaylistDialog(): Promise<void> {
  const dialog = $toRaw(ui).playlist;
  const { name, rootId } = $toRaw(playlistForm);
  if (!dialog || !playlistReady()) {
    return Promise.resolve();
  }
  if (dialog.mode === "delete") {
    return run(async () => ((await deletePlaylist(dialog.rootId, dialog.path)) ? null : library.errorMessage ?? ""));
  }
  if (dialog.mode === "queue") {
    return run(() => saveQueueAsPlaylist(rootId, name));
  }
  return run(() => createPlaylist(dialog.rootId, name, dialog.trackIds));
}

/** Adds the dialog's tracks to one of the root's playlists. */
export function addToChosenPlaylist(path: string): Promise<void> {
  const dialog = $toRaw(ui).playlist;
  if (!dialog || dialog.mode !== "add") {
    return Promise.resolve();
  }
  return run(async () => ((await addToPlaylist(dialog.rootId, path, dialog.trackIds)) ? null : library.errorMessage ?? ""));
}

/** A root's playlists follow its renamed tracks (old path to new), and are written. */
export function followRenameInPlaylists(rootId: string, renames: ReadonlyMap<string, string>): void {
  const root = rootOf(rootId);
  for (const playlist of root?.playlists ?? []) {
    const entries = renamedEntries(playlist.entries, renames);
    if (entries) {
      void change(rootId, playlist.path, () => entries);
    }
  }
}
