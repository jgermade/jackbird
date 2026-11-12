/**
 * The page's own keys: Space plays and pauses, where the focus is not on something that takes
 * Space itself. See RECORD/2026-11-03.deck-design-system.WIP.md (2026-11-13 18:45).
 */

/** The key event's parts looked at. */
export type SpaceParts = { key: string; repeat: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean };

/** What takes Space itself: a form's controls, keys and links, and the lists that use it (the tree picks, the queue plays, a menu chooses). */
export const TAKES_SPACE = "input, textarea, select, button, a[href], [contenteditable]:not([contenteditable='false']), [role='tree'], [role='listbox'], [role='menu'], [role='slider'], [role='textbox']";

/** Whether a key press is the play/pause key: Space alone, not held down. */
export function isPlayPauseKey(event: SpaceParts): boolean {
  return event.key === " " && !event.repeat && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
}
