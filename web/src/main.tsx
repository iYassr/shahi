import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import "./styles.css";
import { trackViewport } from "./viewport";

// Before first paint, so the app is never briefly sized to the wrong viewport.
trackViewport();

/**
 * Registered on boot rather than when notifications are turned on.
 *
 * The worker caches the app shell, which is what makes a launch from the home
 * screen instant instead of a white screen and a download. Push needs it too,
 * but push is no longer the only reason for it to exist.
 */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js").catch(() => {
      // A browser that refuses it still gets a working app, just not an
      // instant one.
    });
  });
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
