import "@fontsource/inter/400.css";
import "@fontsource/inter/400-italic.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/500-italic.css";
import "@fontsource/inter/600.css";
import "@fontsource/inter/600-italic.css";
import "@fontsource/inter/700.css";
import "@fontsource/inter/700-italic.css";
import "@fontsource/fraunces/600.css";
import "@fontsource/fraunces/700.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/400-italic.css";
import "@fontsource/ibm-plex-mono/500.css";
import "@fontsource/ibm-plex-mono/500-italic.css";
import "@fontsource/ibm-plex-mono/600.css";
import "@fontsource/ibm-plex-mono/600-italic.css";
import "@fontsource/ibm-plex-mono/700.css";
import "@fontsource/ibm-plex-mono/700-italic.css";

import React from "react";
import ReactDOM from "react-dom/client";

// Stub pivis API when running in browser preview (dev) mode
if (import.meta.env.DEV && !("pivis" in window)) {
  await import("./preview-stub.js");
}

import { App } from "./App.js";
import { ErrorBoundary } from "./components/ErrorBoundary.js";
import "./theme/theme.css";
import "./global.css";

const root = document.getElementById("root");
if (!root) throw new Error("No #root element");

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    {/* Top-level safety net: any uncaught render error in the app shell
        (TitleBar, Sidebar, UpdateBanner, Settings, modals, …) shows a
        reloadable error card instead of silently white-screening the whole
        window. The per-session ErrorBoundary inside App stays for granular
        recovery of transcript/composer crashes. */}
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
