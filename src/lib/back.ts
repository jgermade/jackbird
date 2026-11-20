// The way back on a phone (720px wide and below): the system's back (Android's gesture or key, the
// browser's ‹) steps out of what was opened last, as the app's own ways back do, instead of
// leaving the app. What can be stepped out of, from the bottom up: the library's open levels
// (lib/workspace.ts `treeLevels`), Details in view (`ui.pane`), and the dialogs, sheets and menus
// open, in the order they opened. Each step opened is one entry of the browser's history: opened
// in the app, an entry is pushed; closed in the app, as many are gone back over; and the browser
// going back closes the top step (asking a dialog, which decides: one busy stays, and its entry
// is pushed again). A computer has nothing of it. See
// RECORD/2026-11-03.deck-design-system.WIP.md (2026-11-20).
//
// A dialog, sheet or menu is asked to close with an `mm-dismiss` event on its element (the
// theme's Modal, SubModal and Menu take it as Escape: theme/default/components/).

import { $reactive } from "jq79";
import { ui } from "./ui";
import { leaveLevel, treeLevels } from "./workspace";

const PHONE = "(max-width: 720px)";
/** What counts as a dialog, a sheet or a menu open: the theme's `<dialog>`s and popovers. */
const OVERLAY = "dialog[open], [popover]:popover-open";

const back = $reactive({
  phone: false,
  /** Bumped as a dialog, a sheet or a menu opens or closes. */
  overlays: 0
});

/** The dialogs, sheets and menus open, in the order they opened (the last one on top). */
let opened: Element[] = [];

/** One step that can be gone back from: how to close it. */
type Step = () => void;

function levelKeys(): string[] {
  return treeLevels.value.data.open.map((row) => row.key);
}

/** The steps open now, from the bottom up. */
function steps(): Step[] {
  if (!back.phone) return [];
  const list: Step[] = levelKeys().map((key) => () => leaveLevel(key));
  if (ui.pane === "details") list.push(() => (ui.pane = "library"));
  for (const element of opened) list.push(() => element.dispatchEvent(new Event("mm-dismiss")));
  return list;
}

/** The steps open now, counted: read so that an effect wakes on what changes it. */
function depth(): number {
  void back.overlays;
  return steps().length;
}

/** How many entries of the history are this app's steps (the one it started on is 0). */
let mirrored = 0;
/** Gone back over entries the app closed itself: the `popstate` it brings is not the person's. */
let rewinding = false;
/** Closing the steps the browser went back over: a dialog takes its way out before it is gone. */
let closing = false;

const entryDepth = (state: unknown): number => {
  const value = (state as { jackbirdBack?: unknown } | null)?.jackbirdBack;
  return typeof value === "number" && value >= 0 ? value : 0;
};

/** Brings the history to as many entries as steps open (`target`). */
function reconcile(target: number): void {
  if (rewinding || closing) return;
  if (target > mirrored) {
    const state = history.state !== null && typeof history.state === "object" ? history.state : {};
    while (mirrored < target) {
      mirrored += 1;
      history.pushState({ ...state, jackbirdBack: mirrored }, "");
    }
  } else if (target < mirrored) {
    rewinding = true;
    history.go(target - mirrored);
  }
}

/** How long a dialog's way out may take before what is still open is counted again. */
const SETTLE_MS = 600;

/** The browser went back (or forward): the steps above where it is now close, the top one first. */
function onPopState(event: PopStateEvent): void {
  const at = entryDepth(event.state);
  mirrored = at;
  if (rewinding) {
    rewinding = false;
    reconcile(depth());
    return;
  }
  closing = true;
  // One at a time, from the top. A dialog goes out over a moment, or stays (one busy): then the
  // rest wait, and what is still open is counted once it has had the time to go.
  let count = depth();
  while (count > at) {
    steps()[count - 1]?.();
    const next = depth();
    if (next >= count) break;
    count = next;
  }
  if (count <= at) {
    closing = false;
    reconcile(depth());
    return;
  }
  setTimeout(() => {
    closing = false;
    reconcile(depth());
  }, SETTLE_MS);
}

/** Follows the dialogs, sheets and menus as they open and close. */
function watchOverlays(): void {
  const update = () => {
    const now = new Set(document.querySelectorAll(OVERLAY));
    const kept = opened.filter((element) => now.has(element));
    now.forEach((element) => {
      if (!kept.includes(element)) kept.push(element);
    });
    if (kept.length === opened.length && kept.every((element, index) => element === opened[index])) return;
    opened = kept;
    back.overlays += 1;
  };
  new MutationObserver(update).observe(document.body, { subtree: true, attributes: true, attributeFilter: ["open"] });
  // A popover's opening and closing changes no attribute: its `toggle` (which does not bubble).
  document.addEventListener("toggle", update, true);
}

/** Starts the way back (once, at start-up). */
export function startBack(): void {
  // Not in a frame (the landing page's): its history is the page's around it.
  if (typeof window === "undefined" || typeof history === "undefined" || window.parent !== window) return;
  const media = matchMedia(PHONE);
  back.phone = media.matches;
  media.addEventListener("change", (event) => (back.phone = event.matches));
  // Where the app starts is the bottom: a reload on a step's entry starts there again.
  mirrored = entryDepth(history.state);
  watchOverlays();
  addEventListener("popstate", onPopState);
  // Counted first, every time, so the effect keeps waking on all it reads, even while it waits.
  back.$effect(() => reconcile(depth()));
}
