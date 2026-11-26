// useAuth on app open and on sign-out, against a scripted Supabase.
//  - Boot order (agent-1, measured 26 Nov): the staff-invitation claim was awaited before any read,
//    one extra round trip on every app open. The role read must not wait for it; the staff read must.
//  - Sign-out with no network: Supabase's normal sign-out fails and then KEEPS the login on the
//    device. The app must fall back to a local sign-out.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const sb = vi.hoisted(() => ({
  calls: [] as string[],
  releaseClaim: () => {},
  signOutResults: [] as Array<{ error: { message: string } | null }>,
  signOutArgs: [] as unknown[],
  signOutHangs: false,
  /** Results for the next claim_staff_invitation calls; when empty, the call waits for releaseClaim(). */
  claimResults: [] as Array<{ data: null; error: { message: string; code: string } | null }>,
  staffRows: [] as Array<{ id: string }>,
  authCb: null as null | ((event: string, session: unknown) => void),
}));
const USER = { id: "user-1", user_metadata: {} };

vi.mock("@/integrations/supabase/client", () => {
  const table = (name: string) => {
    const chain = {
      select: () => chain,
      eq: () => chain,
      limit: () => chain,
      then: (resolve: (r: unknown) => unknown) => {
        sb.calls.push(`read ${name}`);
        const data = name === "user_roles" ? (sb.staffRows.length ? [] : [{ role: "owner" }]) : sb.staffRows;
        return Promise.resolve({ data, error: null }).then(resolve);
      },
    };
    return chain;
  };
  return {
    supabase: {
      from: table,
      rpc: (fn: string) => {
        sb.calls.push(`rpc ${fn} start`);
        const next = sb.claimResults.shift();
        if (next) {
          sb.calls.push(`rpc ${fn} done`);
          return Promise.resolve(next);
        }
        return new Promise((resolve) => {
          sb.releaseClaim = () => {
            sb.calls.push(`rpc ${fn} done`);
            resolve({ data: null, error: null });
          };
        });
      },
      auth: {
        getUser: () => Promise.resolve({ data: { user: USER }, error: null }),
        getSession: () => Promise.resolve({ data: { session: null }, error: null }),
        signOut: (args?: unknown) => {
          sb.signOutArgs.push(args ?? "global");
          if (sb.signOutHangs) return new Promise(() => {}); // waiting for Supabase's lock, forever
          return Promise.resolve(sb.signOutResults.shift() ?? { error: null });
        },
        onAuthStateChange: (cb: (event: string, session: unknown) => void) => {
          sb.authCb = cb;
          setTimeout(() => cb("SIGNED_IN", { user: USER }), 0);
          return { data: { subscription: { unsubscribe: () => {} } } };
        },
      },
    },
  };
});

const saved = vi.hoisted(() => ({ forgetSavedLogin: vi.fn(() => 1), restartAt: vi.fn() }));
vi.mock("@/lib/savedLogin", () => saved);

let container: HTMLDivElement;
let root: Root;
let seen: { user: unknown; role: unknown; loading: boolean; isStaff: boolean } | null = null;
let api: { signOut: (o?: { local?: boolean }) => Promise<void> } | null = null;

async function mount() {
  const { AuthProvider, useAuth } = await import("@/hooks/useAuth");
  const Probe = () => {
    const a = useAuth();
    seen = { user: a.user, role: a.role, loading: a.loading, isStaff: a.isStaff };
    api = { signOut: a.signOut };
    return null;
  };
  await act(async () => {
    root.render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
  });
  // Two ticks: the sign-in event, then the deferred role load it schedules after React commits.
  for (let i = 0; i < 2; i++) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  sb.calls = [];
  sb.signOutResults = [];
  sb.signOutArgs = [];
  sb.signOutHangs = false;
  sb.claimResults = [];
  sb.staffRows = [];
  saved.forgetSavedLogin.mockClear();
  saved.restartAt.mockClear();
  seen = null;
  api = null;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("app open: who waits for the staff-invitation claim", () => {
  it("the role read starts before the claim finishes; only the staff read waits for it", async () => {
    await mount();
    expect(sb.calls).toContain("rpc claim_staff_invitation start");
    expect(sb.calls).toContain("read user_roles");
    expect(sb.calls).not.toContain("read staff_members");

    await act(async () => {
      sb.releaseClaim();
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(sb.calls.indexOf("read staff_members")).toBeGreaterThan(sb.calls.indexOf("rpc claim_staff_invitation done"));
    expect(seen).toMatchObject({ role: "owner", loading: false });
  });
});

describe("sign-out", () => {
  async function signedIn() {
    await mount();
    await act(async () => {
      sb.releaseClaim();
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(seen?.user).toBeTruthy();
  }

  it("with no network: the server sign-out fails, so it signs out on this device and the app forgets the user", async () => {
    await signedIn();
    sb.signOutResults = [{ error: { message: "Failed to fetch" } }, { error: null }];
    await act(async () => {
      await api!.signOut();
    });
    expect(sb.signOutArgs).toEqual(["global", { scope: "local" }]);
    expect(seen?.user).toBeNull();
  });

  it("local sign-out (the loading screen's 'Sign in again') never calls the server", async () => {
    await signedIn();
    await act(async () => {
      await api!.signOut({ local: true });
    });
    expect(sb.signOutArgs).toEqual([{ scope: "local" }]);
    expect(seen?.user).toBeNull();
  });

  it("'Sign in again' when Supabase's sign-out is stuck behind its lock: clears the saved login itself and restarts", async () => {
    const { LOCAL_SIGN_OUT_WAIT_MS } = await import("@/hooks/useAuth");
    await signedIn();
    sb.signOutHangs = true;
    let done = false;
    await act(async () => {
      void api!.signOut({ local: true }).then(() => (done = true));
      await vi.advanceTimersByTimeAsync(LOCAL_SIGN_OUT_WAIT_MS - 100);
    });
    expect(saved.forgetSavedLogin).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(done).toBe(true);
    expect(saved.forgetSavedLogin).toHaveBeenCalledTimes(1);
    expect(saved.restartAt).toHaveBeenCalledWith("/auth");
  });

  it("a normal sign-out that works does not sign out twice", async () => {
    await signedIn();
    await act(async () => {
      await api!.signOut();
    });
    expect(sb.signOutArgs).toEqual(["global"]);
  });
});

describe("the staff-invitation claim on a flaky network (Antigravity's review)", () => {
  async function settle() {
    for (let i = 0; i < 12; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
    }
  }

  it("a claim that could not reach the server is retried, so a new staff member is not sent to 'choose your role'", async () => {
    sb.staffRows = [{ id: "staff-1" }]; // the invitation exists; only a successful claim links it
    const networkDown = { data: null, error: { message: "TypeError: Failed to fetch", code: "" } };
    sb.claimResults = [networkDown, { data: null, error: null }];
    await mount();
    await settle();
    expect(sb.calls.filter((c) => c === "rpc claim_staff_invitation start").length).toBe(2);
    expect(seen).toMatchObject({ isStaff: true, loading: false });
  });

  it("a database error from the claim is ignored as before, so a broken function cannot lock everyone out", async () => {
    sb.claimResults = [{ data: null, error: { message: "function does not exist", code: "42883" } }];
    await mount();
    await settle();
    expect(seen).toMatchObject({ role: "owner", loading: false });
  });
});
