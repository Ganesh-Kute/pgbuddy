// What the app is waiting for, shared by the top progress bar and the offline banner.
// Plain stores (subscribe + snapshot) so React reads them with useSyncExternalStore and tests can
// drive them without a browser.

type Listener = () => void;

function emitter() {
  const listeners = new Set<Listener>();
  return {
    subscribe(fn: Listener) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    emit() {
      for (const fn of listeners) fn();
    },
  };
}

// --- Page files being downloaded (lazy pages) -----------------------------------------------------

const pages = emitter();
let pendingPages = 0;

export const pageLoads = {
  subscribe: pages.subscribe,
  count: () => pendingPages,
  /** Call when a page file starts downloading; call the returned function once when it settles. */
  start(): () => void {
    pendingPages++;
    pages.emit();
    let done = false;
    return () => {
      if (done) return;
      done = true;
      pendingPages--;
      pages.emit();
    };
  },
};

// --- Offline ------------------------------------------------------------------------------------
// navigator.onLine alone is not enough: on Android it stays true on Wi-Fi without internet or mobile
// data that carries nothing. So the last request to the server counts too: a request that could not
// reach it means offline, the next one that does means online again.

const net = emitter();
let browserOffline = typeof navigator !== "undefined" && navigator.onLine === false;
let requestFailed = false;

export const network = {
  subscribe: net.subscribe,
  isOffline: () => browserOffline || requestFailed,
  setBrowserOnline(online: boolean) {
    const before = network.isOffline();
    browserOffline = !online;
    // Back online: forget the old failure; the next request will tell if it is really back.
    if (online) requestFailed = false;
    if (network.isOffline() !== before) net.emit();
  },
  reportRequest(ok: boolean) {
    if (requestFailed === !ok) return;
    requestFailed = !ok;
    net.emit();
  },
};

/** fetch's own "could not reach the server" error: a TypeError. An abort or an HTTP error is not one. */
export function isNetworkFailure(err: unknown): boolean {
  return err instanceof TypeError;
}

/**
 * Sign-in requests give up after this. On a network that never answers they would otherwise wait
 * for minutes while holding Supabase's login lock, which every other login step waits for. Only
 * sign-in requests: data reads and photo uploads can rightly take long on a slow connection.
 */
export const AUTH_REQUEST_TIMEOUT_MS = 15_000;

const urlOf = (input: RequestInfo | URL) =>
  typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

/** A fetch that tells `network` whether the server could be reached. Used by the Supabase client. */
export function trackedFetch(fetchFn: typeof fetch = (input, init) => fetch(input, init)): typeof fetch {
  return async (input, init) => {
    const isAuth = urlOf(input).includes("/auth/v1/");
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    let callInit = init;
    if (isAuth) {
      const controller = new AbortController();
      const outer = init?.signal;
      if (outer) {
        if (outer.aborted) controller.abort();
        else outer.addEventListener("abort", () => controller.abort(), { once: true });
      }
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, AUTH_REQUEST_TIMEOUT_MS);
      callInit = { ...init, signal: controller.signal };
    }
    try {
      const res = await fetchFn(input, callInit);
      network.reportRequest(true);
      return res;
    } catch (err) {
      // A timeout is a network failure (the same TypeError fetch gives), not the caller's own abort.
      const failure = timedOut ? new TypeError("Network request timed out") : err;
      if (isNetworkFailure(failure)) network.reportRequest(false);
      throw failure;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}

let listening = false;
/** Follow the browser's online/offline events (once per page). */
export function watchBrowserNetwork(target: Window = window): void {
  if (listening) return;
  listening = true;
  target.addEventListener("online", () => network.setBrowserOnline(true));
  target.addEventListener("offline", () => network.setBrowserOnline(false));
}

/** Tests only: back to the start state. */
export function resetLoadingActivityForTests(): void {
  pendingPages = 0;
  browserOffline = false;
  requestFailed = false;
  listening = false;
}
