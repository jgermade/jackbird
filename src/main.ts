// The app's entry: the Deck theme's sheets, the root view, and the work that
// runs behind it (keeping the session saved, verifying checksums, reopening
// the last session and the music it was playing). See RECORD/2026-11-03.deck-design-system.WIP.md
// (steps 6 and 7).

import "../theme/default/fonts.css";
import "../theme/default/tokens.css";
import "../theme/default/content.css";
import "../theme/default/base.css";
import { startAccount } from "./lib/account";
import { keepPlaybackSaved, restorePlayback } from "./lib/player";
import { isDesktop } from "./lib/platform";
import { keepSessionSaved, restoreSession } from "./lib/session";
import { startVerifier } from "./lib/verifier";
import App from "./views/app.html";

App.mount("#app");
keepSessionSaved();
startVerifier();
// The folders come back once someone is in (the service's people, S3); the
// music once its root has: restoring it saves nothing over it.
void startAccount()
  .then(() => restoreSession())
  .then(() => {
    restorePlayback();
    keepPlaybackSaved();
  });
// The desktop app's unattended check (desktop.yml), only when the app is started for it.
if (isDesktop) {
  void import("./lib/sources/check").then((check) => check.runCheckIfAsked());
}
