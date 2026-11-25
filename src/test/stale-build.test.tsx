// "React App Crashed: Failed to fetch dynamically imported module .../assets/Tenants-CE_ZpDRq.js"
// after a deploy: a tab (or the service worker's offline copy) on the previous build asked for page
// files the new deploy had renamed. These tests pin the recovery: reload once into the new build,
// never loop, and show a usable screen when a reload cannot help.
//
// The same behaviour was checked in Chromium against two real builds served like Vercel: before the
// fix both a tab left open across a deploy and the next visit after one showed the crash screen;
// after it, both landed on the new build after exactly one automatic reload.
import fs from "node:fs";
import path from "node:path";
import { act, Suspense, type ComponentType, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "@/ErrorBoundary";
import { createReloader, isChunkLoadError, lazyWithReload, reloadOnStalePreload, type ReloadEnv } from "@/lib/staleBuild";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ROOT = path.resolve(__dirname, "../..");
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), "utf8");

// The exact messages each browser engine gives for a missing module, and Vite's for missing CSS.
const CHROME = new TypeError(
  "Failed to fetch dynamically imported module: https://pgbuddy.getgrm.tech/assets/Tenants-CE_ZpDRq.js",
);
const FIREFOX = new TypeError(
  "error loading dynamically imported module: https://pgbuddy.getgrm.tech/assets/Tenants-CE_ZpDRq.js",
);
const SAFARI = new TypeError("Importing a module script failed.");
const VITE_CSS = new Error("Unable to preload CSS for /assets/Tenants-B8B2yBIb.css");

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (k) => data.get(k) ?? null,
    key: (i) => [...data.keys()][i] ?? null,
    removeItem: (k) => void data.delete(k),
    setItem: (k, v) => void data.set(k, String(v)),
  };
}

function env(over: Partial<ReloadEnv> = {}): ReloadEnv & { reload: ReturnType<typeof vi.fn> } {
  return { buildId: "/assets/index-OLD.js", storage: memoryStorage(), isOnline: () => true, reload: vi.fn(), ...over } as never;
}

describe("isChunkLoadError", () => {
  it("recognises a missing page file in Chrome, Firefox and Safari, and Vite's missing CSS", () => {
    for (const err of [CHROME, FIREFOX, SAFARI, VITE_CSS]) expect(isChunkLoadError(err)).toBe(true);
    expect(isChunkLoadError("Failed to fetch dynamically imported module: /assets/x.js")).toBe(true);
    expect(isChunkLoadError({ name: "ChunkLoadError", message: "Loading chunk 7 failed." })).toBe(true);
  });

  it("does not treat ordinary bugs or network errors from data calls as a new build", () => {
    expect(isChunkLoadError(new TypeError("Cannot read properties of undefined (reading 'map')"))).toBe(false);
    expect(isChunkLoadError(new TypeError("Failed to fetch"))).toBe(false); // a Supabase call, not a page file
    expect(isChunkLoadError(null)).toBe(false);
    expect(isChunkLoadError(undefined)).toBe(false);
    expect(isChunkLoadError(42)).toBe(false);
  });
});

describe("createReloader: one automatic reload per build, never a loop", () => {
  it("reloads the first time and remembers it across the reload", () => {
    const e = env();
    expect(createReloader(e)()).toBe(true);
    expect(e.reload).toHaveBeenCalledTimes(1);

    // The reload landed on the same build and the file is still missing: stop, show the error.
    const afterReload = env({ storage: e.storage });
    expect(createReloader(afterReload)()).toBe(false);
    expect(afterReload.reload).not.toHaveBeenCalled();
  });

  it("allows a reload again once the app is on a newer build (the next deploy)", () => {
    const e = env();
    createReloader(e)();
    const nextBuild = env({ storage: e.storage, buildId: "/assets/index-NEW.js" });
    expect(createReloader(nextBuild)()).toBe(true);
    expect(nextBuild.reload).toHaveBeenCalledTimes(1);
  });

  it("several failures in one page start a single reload and all wait for it", () => {
    const e = env();
    const reloadForNewBuild = createReloader(e);
    expect([reloadForNewBuild(), reloadForNewBuild(), reloadForNewBuild()]).toEqual([true, true, true]);
    expect(e.reload).toHaveBeenCalledTimes(1);
  });

  it("does not reload when offline (the reload would show the browser's offline page)", () => {
    const e = env({ isOnline: () => false });
    expect(createReloader(e)()).toBe(false);
    expect(e.reload).not.toHaveBeenCalled();
  });

  it("does not reload when it cannot remember the attempt (blocked storage could loop)", () => {
    const none = env({ storage: null });
    expect(createReloader(none)()).toBe(false);
    const throwing = env({
      storage: {
        getItem: () => {
          throw new Error("SecurityError");
        },
        setItem: () => {},
      },
    });
    expect(createReloader(throwing)()).toBe(false);
    expect(none.reload).not.toHaveBeenCalled();
    expect(throwing.reload).not.toHaveBeenCalled();
  });
});

let container: HTMLDivElement;
let root: Root;
let consoleError: ReturnType<typeof vi.spyOn>;

/** Renders and lets React settle (lazy imports, error boundaries) before returning. */
async function show(node: ReactNode) {
  await act(async () => {
    root.render(node);
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}
const text = () => container.textContent ?? "";
const q = (selector: string) => container.querySelector(selector);

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {}); // React logs caught errors
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  consoleError.mockRestore();
});

describe("lazyWithReload", () => {
  const Page = () => <p>Tenants page</p>;
  const ok = () => Promise.resolve({ default: Page as ComponentType });
  const fail = (err: unknown) => () => Promise.reject(err);

  const inApp = (Lazy: ComponentType, reload: () => boolean) => (
    <ErrorBoundary reloadForNewBuild={reload}>
      <Suspense fallback={<p>Loading…</p>}>
        <Lazy />
      </Suspense>
    </ErrorBoundary>
  );

  it("renders the page when its file loads", async () => {
    await show(inApp(lazyWithReload(ok), () => false));
    expect(text()).toBe("Tenants page");
  });

  it("on a missing page file: starts the reload and keeps the loading screen up (no crash screen)", async () => {
    const reload = vi.fn(() => true);
    await show(inApp(lazyWithReload(fail(CHROME), reload), reload));
    expect(reload).toHaveBeenCalledTimes(1);
    expect(text()).toBe("Loading…");
  });

  it("when the reload already happened for this build: a clear message with a Reload button", async () => {
    const reload = vi.fn(() => false);
    await show(inApp(lazyWithReload(fail(SAFARI), reload), reload));
    expect(q("h1")?.textContent).toBe("This page could not load");
    expect(q("button")?.textContent).toBe("Reload");
    expect(q("a")?.getAttribute("href")).toBe("/");
    expect(text()).not.toMatch(/React App Crashed/);
  });

  it("does not reload for an ordinary bug in the page", async () => {
    const reload = vi.fn(() => true);
    await show(inApp(lazyWithReload(fail(new TypeError("x is not a function")), reload), reload));
    expect(q("h1")?.textContent).toBe("Something went wrong");
    expect(reload).not.toHaveBeenCalled();
  });
});

describe("ErrorBoundary", () => {
  const Throw = ({ error }: { error: Error }) => {
    throw error;
  };

  it("a missing page file that reached it: shows 'Updating…' while it reloads", async () => {
    const reload = vi.fn(() => true);
    await show(
      <ErrorBoundary reloadForNewBuild={reload}>
        <Throw error={CHROME} />
      </ErrorBoundary>,
    );
    expect(q('[role="status"]')?.textContent).toMatch(/Updating to the latest version/);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("other errors: a friendly screen; the technical details are kept, folded away", async () => {
    await show(
      <ErrorBoundary reloadForNewBuild={() => true}>
        <Throw error={new TypeError("Cannot read properties of undefined (reading 'map')")} />
      </ErrorBoundary>,
    );
    expect(q('[role="alert"] h1')?.textContent).toBe("Something went wrong");
    expect(text()).not.toMatch(/React App Crashed/);
    expect(q("details summary")?.textContent).toBe("Technical details");
    expect(q("details pre")?.textContent).toMatch(/reading 'map'/);
  });
});

describe("reloadOnStalePreload (Vite's vite:preloadError)", () => {
  it("reloads for a missing file, not for other preload errors", () => {
    const target = new EventTarget() as unknown as Window;
    const reload = vi.fn(() => true);
    reloadOnStalePreload(target, reload);

    const fire = (payload: unknown) => {
      const event = new Event("vite:preloadError", { cancelable: true }) as Event & { payload?: unknown };
      event.payload = payload;
      target.dispatchEvent(event);
      return event;
    };
    expect(fire(new Error("something else")).defaultPrevented).toBe(false);
    expect(reload).not.toHaveBeenCalled();
    // Not prevented: the import still fails, so lazyWithReload keeps its loading screen.
    expect(fire(FIREFOX).defaultPrevented).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe("wiring", () => {
  it("every page in App.tsx is loaded through lazyWithReload", () => {
    const app = read("src/App.tsx");
    expect(app).not.toMatch(/(^|[^\w.])lazy\(/m);
    expect((app.match(/lazyWithReload\(\(\) => import\(/g) ?? []).length).toBeGreaterThan(50);
  });

  it("main.tsx installs the preload handler and registers no service worker of its own", () => {
    const main = read("src/main.tsx");
    expect(main).toMatch(/reloadOnStalePreload\(\)/);
    expect(main).not.toMatch(/serviceWorker\.register/);
  });

  it("push handlers are loaded into the one generated service worker", () => {
    expect(read("vite.config.ts")).toMatch(/importScripts:\s*\["sw-push\.js"\]/);
    expect(read("public/sw-push.js")).toMatch(/addEventListener\("push"/);
  });
});
