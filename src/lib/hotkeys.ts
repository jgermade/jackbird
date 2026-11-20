// The page's own keys (helpers/hotkeys.ts): Space plays and pauses wherever the focus is not on
// something that takes Space itself, in the page and in the compact player's floating window.
// Ctrl or ⌘ with F, or "/", opens the search. See RECORD/2026-11-03.deck-design-system.WIP.md
// (2026-11-13 18:45; the search 2026-11-20).

import { isPlayPauseKey, isSearchKey, TAKES_SPACE } from "../helpers/hotkeys";
import { nowPlaying, togglePlay } from "./player";
import { library } from "./library";
import { openSearch } from "./search";

/** Space, heard on a document: plays or pauses the track loaded, unless the focus takes Space. */
export function onSpace(event: KeyboardEvent): void {
  if (event.defaultPrevented || !isPlayPauseKey(event)) return;
  const target = event.target as Element | null;
  if (target && typeof target.closest === "function" && target.closest(TAKES_SPACE)) return;
  if (!nowPlaying.value) return;
  event.preventDefault();
  togglePlay();
}

/** Ctrl or ⌘ with F, or "/" where nothing is typed: the search, with a tab open (lib/search.ts). */
export function onSearchKey(event: KeyboardEvent): void {
  const target = event.target as Element | null;
  const typing = !!target && typeof target.closest === "function" && !!target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])");
  if (event.defaultPrevented || !isSearchKey(event, typing) || !library.activeRootId) return;
  event.preventDefault();
  openSearch();
}

/** Listens for the keys on the page. */
export function startHotkeys(): void {
  document.addEventListener("keydown", onSpace);
  document.addEventListener("keydown", onSearchKey);
}
