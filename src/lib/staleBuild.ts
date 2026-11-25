// Recovering when the website was updated while it was open.
//
// Every page of the app is a separate file whose name carries a hash of its content
// (e.g. /assets/Tenants-CE_ZpDRq.js), and a change to shared code renames most of them: measured on
// this app, one small change renamed 129 of 151 files. A tab opened before a deploy, or the offline
// copy the service worker serves on the next visit, still asks for the old names, which the new
// deploy no longer has (404), so opening any page it had not loaded yet crashed the app with
// "Failed to fetch dynamically imported module".
//
// The cure is to reload once: the reload fetches the new index.html, which names the new files.
// At most one automatic reload per build and tab, so a page that is really missing, or a phone that
// is offline, shows an error with a Reload button instead of reloading forever.

import { lazy, type ComponentType, type LazyExoticComponent } from "react";

/** What browsers and Vite say when a page file cannot be loaded. */
const CHUNK_ERROR_PATTERNS: readonly RegExp[] = [
  /Failed to fetch dynamically imported module/i, // Chrome, Edge, Samsung Internet
  /error loading dynamically imported module/i, // Firefox
  /Importing a module script failed/i, // Safari
  /Unable to preload CSS/i, // Vite, when a page's stylesheet is missing
  /Loading (CSS )?chunk \S+ failed/i, // webpack-built libraries
  /ChunkLoadError/i,
];

export function isChunkLoadError(err: unknown): boolean {
  if (err == null) return false;
  const name = typeof (err as { name?: unknown }).name === "string" ? (err as { name: string }).name : "";
  const message =
    typeof err === "string"
      ? err
      : typeof (err as { message?: unknown }).message === "string"
        ? (err as { message: string }).message
        : "";
  const text = `${name} ${message}`;
  return CHUNK_ERROR_PATTERNS.some((re) => re.test(text));
}

export type ReloadEnv = {
  /** Identifies the running build; one automatic reload is allowed per build. */
  buildId: string;
  /** Survives the reload (sessionStorage); null when the browser blocks storage. */
  storage: Pick<Storage, "getItem" | "setItem"> | null;
  isOnline: () => boolean;
  reload: () => void;
};

const KEY_PREFIX = "pgbuddy:reloaded-for-build:";

/**
 * Returns a function that reloads the page into the newest build, at most once per build.
 * It returns true when a reload is under way (keep showing a loading screen), false when the caller
 * should show an error instead (already tried for this build, offline, or no storage to remember
 * the attempt, which could otherwise loop).
 */
export function createReloader(env: ReloadEnv): () => boolean {
  let started = false;
  return () => {
    if (started) return true;
    if (!env.storage || !env.isOnline()) return false;
    const key = KEY_PREFIX + env.buildId;
    try {
      if (env.storage.getItem(key)) return false;
      env.storage.setItem(key, new Date().toISOString());
    } catch {
      return false;
    }
    started = true;
    env.reload();
    return true;
  };
}

function browserEnv(): ReloadEnv {
  let storage: ReloadEnv["storage"] = null;
  try {
    storage = window.sessionStorage;
  } catch {
    storage = null;
  }
  return {
    // In the built app this file is part of the main bundle, whose name changes with every build.
    buildId: import.meta.url,
    storage,
    isOnline: () => navigator.onLine !== false,
    reload: () => window.location.reload(),
  };
}

let defaultReloader: (() => boolean) | null = null;

/** The app's reloader (see createReloader). */
export function reloadForNewBuild(): boolean {
  defaultReloader ??= createReloader(browserEnv());
  return defaultReloader();
}

/**
 * React.lazy that, when the page file is gone because the site was updated, reloads into the new
 * build and keeps the loading screen up meanwhile, instead of crashing.
 */
export function lazyWithReload<T extends ComponentType<any>>( // eslint-disable-line @typescript-eslint/no-explicit-any -- same bound as React.lazy
  factory: () => Promise<{ default: T }>,
  reload: () => boolean = reloadForNewBuild,
): LazyExoticComponent<T> {
  return lazy(() =>
    factory().catch((err: unknown) => {
      if (isChunkLoadError(err) && reload()) return new Promise<{ default: T }>(() => {});
      throw err;
    }),
  );
}

/**
 * Covers dynamic imports outside lazy pages (e.g. the language files): Vite fires
 * "vite:preloadError" when one fails. The error still reaches the caller.
 */
export function reloadOnStalePreload(target: Window = window, reload: () => boolean = reloadForNewBuild): void {
  target.addEventListener("vite:preloadError", (event) => {
    if (isChunkLoadError((event as Event & { payload?: unknown }).payload)) reload();
  });
}
