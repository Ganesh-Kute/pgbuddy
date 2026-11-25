import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import { ErrorBoundary } from "./ErrorBoundary";
import "./index.css";
import { applyBrandTheme, getAppName } from "./lib/branding";
import { reloadOnStalePreload } from "./lib/staleBuild";

document.title = getAppName() + " - Management Portal";
applyBrandTheme();
reloadOnStalePreload();

// The service worker (offline copy + push notifications) is registered by vite-plugin-pwa; the push
// handlers in public/sw-push.js are loaded into it (vite.config.ts). Registering sw-push.js here as a
// second worker for the same scope made the two replace each other on every visit, and the one left
// active had no push handler.

createRoot(document.getElementById("root")!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
);
