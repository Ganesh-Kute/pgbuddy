// A tenant logging in from a phone browser (2026-11-25, 18:36 UTC) was shown "Finish setting up your
// account". Server logs: the OTP verify succeeded, then not one database request arrived from that
// browser, so the role read failed inside the browser, and a failed read was taken for "no role".
// The same account in the app read its role normally (all 200s at 18:16).
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { guardDecision } from "@/lib/auth-roles";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("guardDecision when the role could not be read", () => {
  const failed = { loading: false, signedIn: true, role: null, isStaff: false, accessFailed: true } as const;

  it("asks to retry instead of showing the account-setup screen", () => {
    expect(guardDecision({ ...failed, requiredRole: "tenant" })).toEqual({ kind: "access-error" });
    expect(guardDecision({ ...failed, requiredRole: "owner" })).toEqual({ kind: "access-error" });
  });

  it("still shows the setup screen when the read worked and the account really has no role", () => {
    expect(guardDecision({ ...failed, accessFailed: false, requiredRole: "owner" })).toEqual({ kind: "no-role" });
  });

  it("a role that is known still routes normally", () => {
    expect(guardDecision({ ...failed, role: "tenant", requiredRole: "tenant" })).toEqual({ kind: "render" });
    expect(guardDecision({ ...failed, role: "tenant", requiredRole: "owner" })).toEqual({ kind: "redirect", to: "/tenant" });
  });
});

// --- AuthProvider against a scripted Supabase ------------------------------------------------------

type Result = { data: unknown; error: { message: string; code?: string } | null };
const script = vi.hoisted(() => ({ roleResults: [] as Result[], roleCalls: 0 }));
const TENANT = { id: "ade0e0d4-0000-0000-0000-000000000000", user_metadata: {} };
const LOCK_TIMEOUT: Result = {
  data: null,
  error: { message: "NavigatorLockAcquireTimeoutError: Acquiring an exclusive Navigator LockManager lock timed out" },
};

vi.mock("@/integrations/supabase/client", () => {
  const query = (table: string) => {
    const chain = {
      select: () => chain,
      eq: () => chain,
      limit: () => chain,
      then: (resolve: (r: Result) => unknown) => {
        if (table === "user_roles") {
          const r = script.roleResults[Math.min(script.roleCalls, script.roleResults.length - 1)];
          script.roleCalls++;
          return Promise.resolve(r).then(resolve);
        }
        return Promise.resolve({ data: [], error: null }).then(resolve);
      },
    };
    return chain;
  };
  return {
    supabase: {
      rpc: () => Promise.resolve({ data: null, error: null }),
      from: query,
      auth: {
        getUser: () => Promise.resolve({ data: { user: TENANT }, error: null }),
        signOut: () => Promise.resolve({ error: null }),
        onAuthStateChange: (cb: (event: string, session: unknown) => void) => {
          setTimeout(() => cb("SIGNED_IN", { user: TENANT }), 0);
          return { data: { subscription: { unsubscribe: () => {} } } };
        },
      },
    },
  };
});

describe("AuthProvider: reading the role", () => {
  let container: HTMLDivElement;
  let root: Root;
  let seen: { role: unknown; loading: boolean; accessFailed: boolean } | null;

  beforeEach(() => {
    vi.useFakeTimers();
    script.roleCalls = 0;
    seen = null;
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

  async function signIn() {
    const { AuthProvider, useAuth } = await import("@/hooks/useAuth");
    const Probe = () => {
      const a = useAuth();
      seen = { role: a.role, loading: a.loading, accessFailed: a.accessFailed };
      return null;
    };
    await act(async () => {
      root.render(
        <AuthProvider>
          <Probe />
        </AuthProvider>,
      );
    });
    // Let the sign-in event, the deferred read and every retry delay run.
    for (let i = 0; i < 12; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
    }
  }

  it("a short failure is retried and the tenant gets their role", async () => {
    script.roleResults = [LOCK_TIMEOUT, LOCK_TIMEOUT, { data: [{ role: "tenant" }], error: null }];
    await signIn();
    expect(seen).toEqual({ role: "tenant", loading: false, accessFailed: false });
    expect(script.roleCalls).toBe(3);
  });

  it("a lasting failure is reported as failed, not as an account without a role", async () => {
    script.roleResults = [LOCK_TIMEOUT];
    await signIn();
    expect(seen).toEqual({ role: null, loading: false, accessFailed: true });
    expect(script.roleCalls).toBe(4); // first try + 3 retries
  });

  it("an account that really has no role is not marked failed (setup screen is right)", async () => {
    script.roleResults = [{ data: [], error: null }];
    await signIn();
    expect(seen).toEqual({ role: null, loading: false, accessFailed: false });
    expect(script.roleCalls).toBe(1);
  });
});
