import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import { takePairingFragment } from "./connection";
import { Boundary } from "./components/Boundary";
import "./styles.css";
import { trackViewport } from "./viewport";

// Consume the secret once, before StrictMode can initialize components twice.
const pairingCode = takePairingFragment();

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
    void navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`, { scope: import.meta.env.BASE_URL }).catch(() => {
      // A browser that refuses it still gets a working app, just not an
      // instant one.
    });
  });
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter basename={import.meta.env.BASE_URL}>
      {/* Outside the router, so a screen that throws does not take the app with
          it and leave a blank page — the shape of "I have to refresh a lot". */}
      <Boundary>
        <App initialPairingCode={pairingCode} />
      </Boundary>
    </BrowserRouter>
  </StrictMode>,
);
