// The app's entry: the Deck theme's sheets, the root view, and the work that
// runs behind it (keeping the session saved, verifying checksums, reopening
// the last session). See RECORD/2026-11-03.deck-design-system.WIP.md
// (steps 6 and 7).

import "../theme/default/fonts.css";
import "../theme/default/tokens.css";
import "../theme/default/content.css";
import "../theme/default/base.css";
import { keepSessionSaved, restoreSession } from "./lib/session";
import { startVerifier } from "./lib/verifier";
import App from "./views/app.html";

App.mount("#app");
keepSessionSaved();
startVerifier();
void restoreSession();
