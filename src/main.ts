// The app's entry: the Deck theme's sheets, the root view, and the work that
// runs behind it (keeping the session saved, verifying checksums, reopening
// the last session and the music it was playing). See RECORD/2026-11-03.deck-design-system.WIP.md
// (steps 6 and 7).

import "../theme/default/fonts.css";
import "../theme/default/tokens.css";
import "../theme/default/content.css";
import "../theme/default/base.css";
import { startAccount } from "./lib/account";
import { startCompact } from "./lib/compact";
import { keepFaviconLit } from "./lib/favicon";
import { startBack } from "./lib/back";
import { startHotkeys } from "./lib/hotkeys";
import { loadRecent } from "./lib/recent";
import { loadFavourites, startMine } from "./lib/mine";
import { keepPlaybackSaved, restorePlayback } from "./lib/player";
import { embedKind, isDesktop, isEmbed, isPhone } from "./lib/platform";
import { followActiveRoot, keepSessionSaved, restoreSession } from "./lib/session";
import { startVerifier } from "./lib/verifier";
import App from "./views/app.html";

// The macOS app: its scrollbars as the browser's, shown while pointed at (theme/default/base.css).
if (isDesktop && !isPhone && /Mac/.test(navigator.platform || navigator.userAgent)) document.documentElement.classList.add("mac-app");
App.mount("#app");
keepFaviconLit();
startCompact();
startHotkeys();
// Embedded in the landing page (`?embed`): the sample music at once, and nothing of this browser's
// own session (restored or saved), so the demo (/demo/) keeps its own.
if (isEmbed) {
  void startEmbedded();
} else {
  startSession();
}

/**
 * The app embedded in the landing page: nothing to restore; the sample music. Its windows queue it,
 * paused, and play it; its phone follows their player (lib/mirror.ts), and queues it itself only
 * when there are no windows to follow.
 */
async function startEmbedded(): Promise<void> {
  const [{ library }, { sampleList }, { openSamples }, { queueWhatIsShown }, { startMirror }] = await Promise.all([
    import("./lib/library"),
    import("./lib/sources/samples"),
    import("./lib/roots"),
    import("./lib/workspace"),
    import("./lib/mirror")
  ]);
  const following = startMirror();
  library.restoring = false;
  const list = await sampleList();
  if (!list) return;
  await openSamples(list);
  // Its tracks come with the folder's walk (the first time, their copies too): shown, and queued, once read.
  for (let waited = 0; waited < 120; waited += 1) {
    const root = library.roots.find((one) => one.id === library.activeRootId);
    if (root && root.tracks.length > 0 && !root.loadingMetadata) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  tellLandingDrawn();
  if (await following.then((joined) => joined && embedKind === "phone")) return;
  queueWhatIsShown();
}

/**
 * Tells the landing page the app has drawn its music: until then the page shows its screenshots and
 * keeps the app hidden over them, so a half-drawn app is not seen over them (landing/landing.js).
 */
function tellLandingDrawn(): void {
  if (window.parent === window) return;
  // Two frames: the one the tracks' rows are drawn in, and the one after it, painted.
  requestAnimationFrame(() => requestAnimationFrame(() => window.parent.postMessage({ type: "jackbird:drawn" }, location.origin)));
}

function startSession(): void {
  void loadRecent();
  startBack();
  keepSessionSaved();
  startVerifier();
  // The folders come back once someone is in (the service's people, S3); the
  // music once its root has: restoring it saves nothing over it.
  void startAccount()
    .then(() => startMine())
    .then(() => restoreSession())
    .then(() => {
      void loadFavourites();
      followActiveRoot();
      restorePlayback();
      keepPlaybackSaved();
    });
}
// The desktop app's unattended check (desktop.yml), only when the app is started for it.
if (isDesktop && !isPhone) {
  void import("./lib/sources/check").then((check) => check.runCheckIfAsked());
  // The iPods plugged in at start-up, so "Send to iPod" is offered at once; the sources panel
  // watches them while it shows (RECORD/2026-11-14.ipod-sync.WIP.md, W0).
  void import("./lib/ipod").then((ipod) => ipod.lookForIpods());
}
// An Android phone draws the app under its bars and camera: the page keeps clear of them.
// Its keyboard too; in a browser (and the iPhone app), the page follows it from the visual viewport.
if (isPhone && /Android/.test(navigator.userAgent)) {
  void import("./lib/safe-area").then((area) => area.keepClearOfEdges());
} else if (!isDesktop || isPhone) {
  void import("./lib/keyboard").then((keyboard) => keyboard.followKeyboard());
}
// A phone's (mobile.yml), only in a build made for it.
if (isPhone) {
  void import("./lib/phone-check").then((check) => check.runPhoneCheckIfBuilt());
}
