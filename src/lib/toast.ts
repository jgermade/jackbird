// A short word that comes and goes by itself, over the app's bottom (views/toast.html): something
// done that needs no answer, and belongs to no list (an iPod ejected: its tab is closed already, so
// the library's message would sit over another root's). One at a time; a new one takes its place.
// See RECORD/2026-11-03.deck-design-system.WIP.md (2026-11-15).

import { $reactive } from "jq79";

/** How long a toast stays, in milliseconds. */
export const TOAST_MS = 5000;

/** The toast shown, if any; `id` tells one toast from the next of the same words. */
export const toast = $reactive({ text: null as string | null, id: 0 });

let timer: ReturnType<typeof setTimeout> | null = null;

/** Shows `text` for a while (`ms`), in place of any toast shown. */
export function showToast(text: string, ms: number = TOAST_MS): void {
  if (timer) clearTimeout(timer);
  toast.id += 1;
  toast.text = text;
  timer = setTimeout(hideToast, ms);
}

/** Takes the toast away. */
export function hideToast(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  toast.text = null;
}
