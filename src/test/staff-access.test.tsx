import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// Minimal renderHook/waitFor on react-dom, so the test needs no extra dev dependency.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
function renderHook<T>(hook: () => T, { wrapper: Wrapper }: { wrapper: (p: { children: ReactNode }) => JSX.Element }) {
  const result = { current: undefined as unknown as T };
  const Probe = () => { result.current = hook(); return null; };
  act(() => { createRoot(document.createElement("div")).render(<Wrapper><Probe /></Wrapper>); });
  return { result };
}
async function waitFor(check: () => void, timeoutMs = 2000) {
  const start = Date.now();
  for (;;) {
    try { check(); return; } catch (e) {
      if (Date.now() - start > timeoutMs) throw e;
      await act(() => new Promise((r) => setTimeout(r, 10)));
    }
  }
}

// ---- a tiny Supabase stand-in: records every call, answers from `db` ----
const calls: string[] = [];
const db = {
  staff: null as null | { owner_id: string; role: string; property_id: string | null },
  staffPropertyIds: [] as string[],
  ownProperties: [] as { id: string }[],
};
vi.mock("@/integrations/supabase/client", () => {
  const chain = (table: string) => {
    const q = {
      select: () => q,
      eq: () => q,
      limit: () => q,
      maybeSingle: async () => { calls.push(`${table}.maybeSingle`); return { data: db.staff, error: null }; },
      then: (resolve: (v: unknown) => void) => {
        calls.push(`${table}.select`);
        resolve({ data: table === "properties" ? db.ownProperties : [], error: null });
      },
    };
    return q;
  };
  return {
    supabase: {
      from: (t: string) => chain(t),
      rpc: async (fn: string) => { calls.push(`rpc.${fn}`); return { data: db.staffPropertyIds, error: null }; },
    },
  };
});

let auth = { user: null as null | { id: string }, isStaff: false, loading: true };
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => auth }));

import { useStaffAccess, fetchStaffAccess } from "@/hooks/useStaffAccess";

const wrapper = (client: QueryClient) => ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={client}>{children}</QueryClientProvider>
);
const newClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

beforeEach(() => {
  calls.length = 0;
  db.staff = null;
  db.staffPropertyIds = [];
  db.ownProperties = [];
});

describe("fetchStaffAccess", () => {
  it("gives an owner their own id and properties, without a staff lookup", async () => {
    db.ownProperties = [{ id: "p1" }, { id: "p2" }];
    const a = await fetchStaffAccess("owner-1", false);
    expect(a).toEqual({ isStaff: false, effectiveOwnerId: "owner-1", staffRole: null, staffPropertyId: null, accessiblePropertyIds: ["p1", "p2"] });
    expect(calls).toEqual(["properties.select"]);
  });

  it("gives staff the owner's id and only their assigned properties", async () => {
    db.staff = { owner_id: "owner-1", role: "manager", property_id: "p2" };
    db.staffPropertyIds = ["p2"];
    const a = await fetchStaffAccess("staff-1", true);
    expect(a).toEqual({ isStaff: true, effectiveOwnerId: "owner-1", staffRole: "manager", staffPropertyId: "p2", accessiblePropertyIds: ["p2"] });
  });

  it("treats a user whose staff row has gone as an owner", async () => {
    db.ownProperties = [];
    const a = await fetchStaffAccess("ex-staff", true);
    expect(a.isStaff).toBe(false);
    expect(a.effectiveOwnerId).toBe("ex-staff");
  });
});

describe("useStaffAccess", () => {
  it("stays loading while auth is loading, and does not fetch with no user (the old empty first fetch)", () => {
    auth = { user: null, isStaff: false, loading: true };
    const { result } = renderHook(() => useStaffAccess(), { wrapper: wrapper(newClient()) });
    expect(result.current.loading).toBe(true);
    expect(result.current.effectiveOwnerId).toBeNull();
    expect(calls).toEqual([]);
  });

  it("stays loading for a signed-in user until their access has arrived", async () => {
    auth = { user: { id: "owner-1" }, isStaff: false, loading: false };
    db.ownProperties = [{ id: "p1" }];
    const { result } = renderHook(() => useStaffAccess(), { wrapper: wrapper(newClient()) });
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.effectiveOwnerId).toBe("owner-1");
    expect(result.current.accessiblePropertyIds).toEqual(["p1"]);
  });

  it("is fetched once and shared by every component on the page (layout, guard, page)", async () => {
    auth = { user: { id: "owner-1" }, isStaff: false, loading: false };
    const client = newClient();
    const hooks = [1, 2, 3].map(() => renderHook(() => useStaffAccess(), { wrapper: wrapper(client) }));
    await waitFor(() => hooks.forEach((h) => expect(h.result.current.loading).toBe(false)));
    expect(calls).toEqual(["properties.select"]);
  });
});
