// The page's own keys (helpers/hotkeys.ts): Space plays and pauses wherever the focus is not on
// something that takes Space itself, in the page and in the compact player's floating window.
// See RECORD/2026-11-03.deck-design-system.WIP.md (2026-11-13 18:45).

import { isPlayPauseKey, TAKES_SPACE } from "../helpers/hotkeys";
import { nowPlaying, togglePlay } from "./player";

/** Space, heard on a document: plays or pauses the track loaded, unless the focus takes Space. */
export function onSpace(event: KeyboardEvent): void {
  if (event.defaultPrevented || !isPlayPauseKey(event)) return;
  const target = event.target as Element | null;
  if (target && typeof target.closest === "function" && target.closest(TAKES_SPACE)) return;
  if (!nowPlaying.value) return;
  event.preventDefault();
  togglePlay();
}

/** Listens for the keys on the page. */
export function startHotkeys(): void {
  document.addEventListener("keydown", onSpace);
}
