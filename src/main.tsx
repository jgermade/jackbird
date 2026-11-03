import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
// The Deck theme first; the legacy stylesheet still draws the screens not
// yet moved to jq79 views (ROADMAP/2026-11-03/deck-design-system.md).
import "../theme/default/fonts.css";
import "../theme/default/tokens.css";
import "../theme/default/content.css";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
