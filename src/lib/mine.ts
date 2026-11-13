// Each person's own in the family library (F3): their favourites, the songs
// they play (a play counts once half the song, or four minutes, has played),
// what a song's tags are made of (theirs, the family's, the suggestions) with
// "back to the family's" and, for editors, "apply to everyone", clearing their
// history, and their settings (theme, language, which version) kept with them
// on the service. Their playlists are the library's "My playlists" folder,
// which the playlists' own code reads and writes. See
// RECORD/2026-08-11.musikmatch-rust-migration.WIP.md (2026-11-09, 14:39).

import { $reactive, $toRaw } from "jq79";
import { ownPlaylistPaths } from "../helpers/plays";
import { account } from "./account";
import { library } from "./library";
import { loadPlaylists } from "./playlists";
import { preferences, setLanguage, setTheme } from "./preferences";
import { refreshRoot } from "./roots";
import {
  applySuggestion as applyToFamily,
  currentServer,
  clearHistory as clearPlays,
  forgetMine as forget,
  notePlayed,
  readLibraryText,
  saveMySettings,
  serviceJson,
  setFavourite,
  songLayers,
  type MySettings,
  type SongLayers
} from "./sources/service";

export const mine = $reactive({
  /** One's favourites, by the music they are in (one's own, "own"; someone's shared, their id). */
  favourites: {} as Record<string, string[]>,
  /** Whether the person sees their own version (else the family's). */
  ownVersion: true,
  /** What the song open in Info is made of. */
  layersPath: "",
  layers: null as SongLayers | null,
  error: ""
});

/** The library's roots of the server spoken to now (E6b-D11): one's own music, and those shared with one (SH-D6). */
function libraryRoots() {
  const server = currentServer();
  return $toRaw(library).roots.filter((root) => root.source.kind === "library" && (root.source.server ?? null) === server);
}

/** One's own music's root, if it is open. */
function libraryRoot() {
  return libraryRoots().find((root) => root.source.shelf === undefined) ?? null;
}

/** The library root in view, if the root in view is one: the songs the person acts on are its. */
function rootInView() {
  const active = $toRaw(library).activeRootId;
  return libraryRoots().find((root) => root.id === active) ?? libraryRoot();
}

/** The key of a root's favourites in `mine.favourites`. */
const shelfKey = (shelf: number | undefined): string => (shelf === undefined ? "own" : String(shelf));

/** Whether a root is the family library. */
export function isLibraryRoot(rootId: string | null | undefined): boolean {
  return Boolean(rootId) && libraryRoot()?.id === rootId;
}

async function reloadOwnPlaylists(): Promise<void> {
  const root = rootInView();
  if (!root) return;
  const walked = await root.source.walk();
  await loadPlaylists(root.id, walked.map((entry) => entry.path));
}

/**
 * Reads one's favourites in each music of the library open (the "My playlists/Favourites.m3u"
 * the service makes in each: that music's songs).
 */
export async function loadFavourites(): Promise<void> {
  const found: Record<string, string[]> = {};
  for (const root of libraryRoots()) {
    const text = await readLibraryText("My playlists/Favourites.m3u", root.source.shelf).catch(() => "");
    found[shelfKey(root.source.shelf)] = ownPlaylistPaths(text);
  }
  mine.favourites = found;
}

export function isFavourite(path: string): boolean {
  return (mine.favourites[shelfKey(rootInView()?.source.shelf)] ?? []).includes(path);
}

/** Marks a song (of the music in view) as a favourite, or not. */
export async function toggleFavourite(path: string): Promise<void> {
  const on = !isFavourite(path);
  const shelf = rootInView()?.source.shelf;
  await setFavourite(path, on, shelf);
  const key = shelfKey(shelf);
  const before = mine.favourites[key] ?? [];
  mine.favourites = { ...mine.favourites, [key]: on ? [...before, path] : before.filter((one) => one !== path) };
  if (mine.layersPath === path && mine.layers) mine.layers = { ...mine.layers, favourite: on };
  await reloadOwnPlaylists();
}

/** Records a play of a song of the library. */
export function played(rootId: string, path: string): void {
  // Counted on the root's own server, which may not be the one in front (E6b-D11), in its music.
  const root = $toRaw(library).roots.find((one) => one.id === rootId);
  if (root?.source.kind === "library" && root.source.server) void notePlayed(path, root.source.server, root.source.shelf).catch(() => undefined);
}

/** Loads what a song's tags are made of, for Info (or forgets it, given null). */
export async function loadLayers(path: string | null): Promise<void> {
  if (path === mine.layersPath) return;
  mine.layersPath = path ?? "";
  mine.layers = null;
  if (!path) return;
  const layers = await songLayers(path, rootInView()?.source.shelf).catch(() => null);
  if (mine.layersPath === path) mine.layers = layers;
}

async function reread(path: string): Promise<void> {
  mine.layersPath = "";
  await loadLayers(path);
  const root = rootInView();
  if (root) await refreshRoot(root.id);
}

/** Back to the family's version of a song. */
export async function backToFamily(path: string): Promise<void> {
  await forget(path, rootInView()?.source.shelf);
  await reread(path);
}

/** Applies a suggestion to the family's version (editors). */
export async function applySuggestion(path: string, id: number): Promise<void> {
  await applyToFamily(path, id, rootInView()?.source.shelf);
  await reread(path);
}

/** Clears one's history. */
export async function clearHistory(): Promise<void> {
  await clearPlays();
  await reloadOwnPlaylists();
}

/** Applies the settings kept with the person, then keeps them as they change. */
export function followSettings(settings: MySettings | undefined): void {
  if (settings?.theme) setTheme(settings.theme);
  if (settings?.language) setLanguage(settings.language as typeof preferences.language);
  mine.ownVersion = settings?.mine ?? true;
  let first = true;
  preferences.$effect(() => {
    const change = { theme: preferences.theme, language: preferences.language };
    if (first) {
      first = false;
      return;
    }
    if (account.me) void saveMySettings(change).catch(() => undefined);
  });
}

/** Sees one's own version, or the family's; the library is read again. */
export async function showOwnVersion(on: boolean): Promise<void> {
  await saveMySettings({ mine: on });
  mine.ownVersion = on;
  const root = libraryRoot();
  if (root) {
    location.reload();
  }
}

/** Once someone is in: their settings applied and followed (with no service, nothing). */
export async function startMine(): Promise<void> {
  if (!account.active || !account.me) return;
  const me = await serviceJson<{ settings?: MySettings }>("me").catch(() => null);
  followSettings(me?.settings);
}
