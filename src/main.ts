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
import { startHotkeys } from "./lib/hotkeys";
import { loadRecent } from "./lib/recent";
import { loadFavourites, startMine } from "./lib/mine";
import { keepPlaybackSaved, restorePlayback } from "./lib/player";
import { isDesktop, isEmbed, isPhone } from "./lib/platform";
import { followActiveRoot, keepSessionSaved, restoreSession } from "./lib/session";
import { startVerifier } from "./lib/verifier";
import App from "./views/app.html";

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

/** The app embedded in the landing page: nothing to restore; the sample music, queued paused. */
async function startEmbedded(): Promise<void> {
  const [{ library }, { sampleList }, { openSamples }, { queueWhatIsShown }] = await Promise.all([
    import("./lib/library"),
    import("./lib/sources/samples"),
    import("./lib/roots"),
    import("./lib/workspace")
  ]);
  library.restoring = false;
  const list = await sampleList();
  if (!list) return;
  await openSamples(list);
  // Its tracks come with the folder's walk (the first time, their copies too): queued once read.
  for (let waited = 0; waited < 120; waited += 1) {
    const root = library.roots.find((one) => one.id === library.activeRootId);
    if (root && root.tracks.length > 0 && !root.loadingMetadata) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  queueWhatIsShown();
  // The landing page has two of these: the one that starts tells it, and is told to pause when the
  // other does.
  const [{ playback }, { togglePlay }] = await Promise.all([import("./lib/playback"), import("./lib/player")]);
  playback.$on("playing", () => {
    if (playback.playing) parent.postMessage({ type: "jackbird:playing" }, location.origin);
  });
  window.addEventListener("message", (event) => {
    if (event.origin === location.origin && event.data?.type === "jackbird:pause" && playback.playing) togglePlay();
  });
}

function startSession(): void {
  void loadRecent();
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
}
// An Android phone draws the app under its bars and camera: the page keeps clear of them.
if (isPhone && /Android/.test(navigator.userAgent)) {
  void import("./lib/safe-area").then((area) => area.keepClearOfEdges());
}
// A phone's (mobile.yml), only in a build made for it.
if (isPhone) {
  void import("./lib/phone-check").then((check) => check.runPhoneCheckIfBuilt());
}
