// The app's entry: the Deck theme's sheets, the root view, and the work that
// runs behind it (keeping the session saved, verifying checksums, reopening
// the last session and the music it was playing). See RECORD/2026-11-03.deck-design-system.WIP.md
// (steps 6 and 7).

import "../theme/default/fonts.css";
import "../theme/default/tokens.css";
import "../theme/default/content.css";
import "../theme/default/base.css";
import { startAccount } from "./lib/account";
import { keepFaviconLit } from "./lib/favicon";
import { loadRecent } from "./lib/recent";
import { loadFavourites, startMine } from "./lib/mine";
import { keepPlaybackSaved, restorePlayback } from "./lib/player";
import { isDesktop, isPhone } from "./lib/platform";
import { followActiveRoot, keepSessionSaved, restoreSession } from "./lib/session";
import { startVerifier } from "./lib/verifier";
import App from "./views/app.html";

App.mount("#app");
keepFaviconLit();
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
