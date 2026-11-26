// T1 loading states. Ganesh, 26 Nov: "when I logged in the app I first saw the login screen and then
// instantly the dashboard". In the APK "/" is the sign-in page, and it drew its form while the saved
// login and its role were still being read, then jumped away.
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// --- a scripted useAuth --------------------------------------------------------------------------
type AuthState = {
  user: { id: string } | null;
  role: "owner" | "tenant" | null;
  isStaff: boolean;
  loading: boolean;
  accessFailed: boolean;
};
const auth = vi.hoisted(() => ({
  state: { user: null, role: null, isStaff: false, loading: false, accessFailed: false } as AuthState,
  refreshRole: vi.fn(async () => {}),
  recheckSession: vi.fn(async () => {}),
  signOut: vi.fn(async (_opts?: { local?: boolean }) => {}),
}));
vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({
    ...auth.state,
    session: null,
    refreshRole: auth.refreshRole,
    recheckSession: auth.recheckSession,
    signOut: auth.signOut,
  }),
}));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: { auth: { signInWithOtp: vi.fn(), verifyOtp: vi.fn() }, rpc: vi.fn(), from: vi.fn() },
}));

let container: HTMLDivElement;
let root: Root;
const text = () => container.textContent ?? "";

async function show(node: ReactNode) {
  await act(async () => {
    root.render(<MemoryRouter>{node}</MemoryRouter>);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  auth.state = { user: null, role: null, isStaff: false, loading: false, accessFailed: false };
  auth.refreshRole.mockClear();
  auth.recheckSession.mockClear();
  auth.signOut.mockClear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe("sign-in page while a saved login is being read (the flash Ganesh saw)", () => {
  it("does not draw the sign-in form for a saved login whose role is still loading", async () => {
    const { default: Auth } = await import("@/pages/Auth");
    auth.state = { ...auth.state, user: { id: "u1" }, loading: true };
    await show(<Auth />);
    expect(container.querySelector('input[type="tel"]')).toBeNull();
    expect(text()).not.toMatch(/Send OTP/i);
    // The same loading screen the dashboard uses, straight away: not a blank page.
    expect(container.querySelector('[role="status"][aria-label="Loading"]')).not.toBeNull();
  });

  it("does not flash the form before it knows whether a login is saved", async () => {
    const { default: Auth } = await import("@/pages/Auth");
    auth.state = { ...auth.state, user: null, loading: true };
    await show(<Auth />);
    expect(container.querySelector('input[type="tel"]')).toBeNull();
  });

  it("shows the form once it knows nobody is signed in", async () => {
    const { default: Auth } = await import("@/pages/Auth");
    await show(<Auth />);
    expect(container.querySelector('input[type="tel"]')).not.toBeNull();
  });
});

describe("the loading screen's way out on a slow or broken network", () => {
  it("offers Retry and Sign in again only after 8 s", async () => {
    const { AuthWaitScreen, SLOW_LOGIN_MS } = await import("@/components/ui/AppLoadingSkeleton");
    auth.state = { ...auth.state, user: { id: "u1" }, loading: true };
    await show(<AuthWaitScreen />);
    expect(text()).not.toMatch(/Taking longer/);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SLOW_LOGIN_MS);
    });
    expect(text()).toMatch(/Taking longer than usual/);
  });

  async function slowScreen(user: { id: string } | null) {
    const { AuthWaitScreen, SLOW_LOGIN_MS } = await import("@/components/ui/AppLoadingSkeleton");
    auth.state = { ...auth.state, user, loading: true };
    await show(<AuthWaitScreen />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SLOW_LOGIN_MS);
    });
    const button = (name: string) => [...container.querySelectorAll("button")].find((b) => b.textContent === name)!;
    return { button };
  }

  it("Retry reads the role again for a known login", async () => {
    const { button } = await slowScreen({ id: "u1" });
    await act(async () => button("Retry").click());
    expect(auth.refreshRole).toHaveBeenCalledTimes(1);
    expect(auth.recheckSession).not.toHaveBeenCalled();
  });

  it("Retry reads the saved login again while it is not known yet (refreshRole would do nothing)", async () => {
    const { button } = await slowScreen(null);
    await act(async () => button("Retry").click());
    expect(auth.recheckSession).toHaveBeenCalledTimes(1);
    expect(auth.refreshRole).not.toHaveBeenCalled();
  });

  it("Sign in again still works while a Retry hangs (Antigravity's review: Retry used to disable it)", async () => {
    auth.refreshRole.mockImplementationOnce(() => new Promise(() => {})); // the network never answers
    const { button } = await slowScreen({ id: "u1" });
    await act(async () => button("Retry").click());
    expect(button("Sign in again").disabled).toBe(false);
    await act(async () => button("Sign in again").click());
    expect(auth.signOut).toHaveBeenCalledWith({ local: true });
  });

  it("Sign in again signs out on this device only, which needs no network", async () => {
    const { button } = await slowScreen({ id: "u1" });
    await act(async () => button("Sign in again").click());
    expect(auth.signOut).toHaveBeenCalledWith({ local: true });
  });
});

describe("top progress bar", () => {
  it("counts a page file while it downloads and stops when it arrives or fails", async () => {
    const { pageLoads, resetLoadingActivityForTests } = await import("@/lib/loadingActivity");
    const { lazyWithReload } = await import("@/lib/staleBuild");
    resetLoadingActivityForTests();
    let resolve!: (m: { default: () => null }) => void;
    const Page = lazyWithReload(() => new Promise<{ default: () => null }>((r) => (resolve = r)), () => false);
    const { Suspense } = await import("react");
    await show(
      <Suspense fallback={null}>
        <Page />
      </Suspense>,
    );
    expect(pageLoads.count()).toBe(1);
    await act(async () => resolve({ default: () => null }));
    expect(pageLoads.count()).toBe(0);
  });

  it("appears only when the wait passes 300 ms, so quick loads never flicker", async () => {
    const { pageLoads, resetLoadingActivityForTests } = await import("@/lib/loadingActivity");
    const { TopProgressBar, PROGRESS_DELAY_MS } = await import("@/components/TopProgressBar");
    const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
    resetLoadingActivityForTests();
    await show(
      <QueryClientProvider client={new QueryClient()}>
        <TopProgressBar />
      </QueryClientProvider>,
    );
    let done!: () => void;
    await act(async () => {
      done = pageLoads.start();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PROGRESS_DELAY_MS - 50);
    });
    expect(container.querySelector('[role="progressbar"]')).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(container.querySelector('[role="progressbar"]')).not.toBeNull();
    await act(async () => done());
    expect(container.querySelector('[role="progressbar"]')).toBeNull();
  });
});

describe("offline banner", () => {
  async function setup() {
    const mod = await import("@/lib/loadingActivity");
    mod.resetLoadingActivityForTests();
    const { OfflineBanner } = await import("@/components/OfflineBanner");
    await show(<OfflineBanner />);
    const banner = () => container.querySelector('[role="status"]');
    return { ...mod, banner };
  }

  it("shows when a request cannot reach the server although the phone says it is online", async () => {
    const { trackedFetch, banner } = await setup();
    const failing = trackedFetch(() => Promise.reject(new TypeError("Failed to fetch")));
    await act(async () => {
      await failing("https://x.supabase.co/rest/v1/t").catch(() => {});
    });
    expect(banner()?.textContent).toMatch(/offline/i);
    const working = trackedFetch(() => Promise.resolve(new Response("{}")));
    await act(async () => {
      await working("https://x.supabase.co/rest/v1/t");
    });
    expect(banner()).toBeNull();
  });

  it("an aborted request or a server error is not 'offline'", async () => {
    const { trackedFetch, banner } = await setup();
    const aborted = trackedFetch(() => Promise.reject(new DOMException("aborted", "AbortError")));
    await act(async () => {
      await aborted("u").catch(() => {});
    });
    const serverError = trackedFetch(() => Promise.resolve(new Response("x", { status: 500 })));
    await act(async () => {
      await serverError("u");
    });
    expect(banner()).toBeNull();
  });

  it("follows the browser's offline and online events", async () => {
    const { banner } = await setup();
    await act(async () => {
      window.dispatchEvent(new Event("offline"));
    });
    expect(banner()).not.toBeNull();
    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    expect(banner()).toBeNull();
  });
});

describe("sign-in requests on a network that never answers", () => {
  it("give up after 15 s (they hold Supabase's login lock) and count as offline", async () => {
    const { trackedFetch, network, AUTH_REQUEST_TIMEOUT_MS, resetLoadingActivityForTests } = await import("@/lib/loadingActivity");
    resetLoadingActivityForTests();
    const never = (_: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
    let error: unknown = null;
    const call = trackedFetch(never)("https://x.supabase.co/auth/v1/user").catch((e) => (error = e));
    await vi.advanceTimersByTimeAsync(AUTH_REQUEST_TIMEOUT_MS + 10);
    await call;
    expect(error).toBeInstanceOf(TypeError);
    expect(network.isOffline()).toBe(true);
  });

  it("data reads and uploads have no time limit (a slow upload is normal)", async () => {
    const { trackedFetch, AUTH_REQUEST_TIMEOUT_MS } = await import("@/lib/loadingActivity");
    let settled = false;
    const never = () => new Promise<Response>(() => {});
    void trackedFetch(never)("https://x.supabase.co/storage/v1/object/receipts/a.jpg").finally(() => (settled = true));
    await vi.advanceTimersByTimeAsync(AUTH_REQUEST_TIMEOUT_MS * 4);
    expect(settled).toBe(false);
  });

  it("the caller's own abort stays an abort, not 'offline'", async () => {
    const { trackedFetch, network, resetLoadingActivityForTests } = await import("@/lib/loadingActivity");
    resetLoadingActivityForTests();
    const controller = new AbortController();
    const never = (_: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
    const call = trackedFetch(never)("https://x.supabase.co/auth/v1/token", { signal: controller.signal }).catch((e) => e);
    controller.abort();
    expect(((await call) as DOMException).name).toBe("AbortError");
    expect(network.isOffline()).toBe(false);
  });
});

describe("Log in with a number that has no account (server says: sign up first)", () => {
  it("switches to Sign up with the number kept, instead of an error dead end", async () => {
    const { supabase } = await import("@/integrations/supabase/client");
    (supabase.auth.signInWithOtp as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: null,
      error: new Error("No account found for this number. Please sign up first."),
    });
    const { default: Auth } = await import("@/pages/Auth");
    await show(<Auth />);
    const tel = container.querySelector<HTMLInputElement>('input[type="tel"]')!;
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setValue.call(tel, "9999902170");
      tel.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      tel.form!.requestSubmit();
    });
    expect(text()).toMatch(/Your Full Name/i);
    expect(container.querySelector<HTMLInputElement>('input[type="tel"]')?.value).toMatch(/9999902170/);
  });
});
