import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// Minimal renderHook/waitFor on react-dom, so the test needs no extra dev dependency.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
function renderHook<T>(hook: () => T, client: QueryClient) {
  const result = { current: undefined as unknown as T };
  const Probe = () => { result.current = hook(); return null; };
  let root: Root;
  act(() => {
    root = createRoot(document.createElement("div"));
    root.render(<QueryClientProvider client={client}><Probe /></QueryClientProvider>);
  });
  return { result, unmount: () => act(() => root.unmount()) };
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

// ---- a Supabase stand-in: records each request when it is SENT, answers only when the test says so ----
type Answer = { data: unknown; error: null | { message: string }; count?: number };
const sent: { table: string; filters: string[]; resolve: () => void }[] = [];
let autoAnswer = true;
let failTable: string | null = null;
const rows: Record<string, unknown[]> = {};

vi.mock("@/integrations/supabase/client", () => {
  const chain = (table: string) => {
    const filters: string[] = [];
    let head = false;
    const q: Record<string, unknown> = {
      select: (_c: string, opts?: { head?: boolean }) => { head = !!opts?.head; return q; },
      eq: (c: string, v: unknown) => { filters.push(`${c}=${v}`); return q; },
      in: (c: string, v: unknown[]) => { filters.push(`${c} in ${v.join(",")}`); return q; },
      gte: () => q, lte: () => q, order: () => q, limit: () => q,
      then: (resolve: (v: Answer) => void) => {
        const answer = (): Answer => failTable === table
          ? { data: null, error: { message: "network" } }
          : head ? { data: null, error: null, count: (rows[table] ?? []).length } : { data: rows[table] ?? [], error: null };
        const entry = { table, filters, resolve: () => resolve(answer()) };
        sent.push(entry);
        if (autoAnswer) entry.resolve();
      },
    };
    return q;
  };
  return { supabase: { from: (t: string) => chain(t) } };
});

import { useDashboardData } from "@/hooks/useDashboardData";

const range = { from: new Date("2026-08-01T00:00:00Z"), to: new Date("2026-11-01T00:00:00Z") };
const owner = { ownerId: "owner-1", accessiblePropertyIds: ["p1", "p2"], staffPropertyId: null, filterPropertyId: "all", range, enabled: true };
const newClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

beforeEach(() => {
  sent.length = 0;
  autoAnswer = true;
  failTable = null;
  for (const k of Object.keys(rows)) delete rows[k];
  rows.properties = [{ id: "p1", name: "Shanti PG" }, { id: "p2", name: "Mauli PG" }];
  rows.rooms = [{ id: "r1", is_vacant: false, capacity: 3, property_id: "p1" }];
  rows.tenant_assignments = [{ id: "t1", property_id: "p1" }, { id: "t2", property_id: "p1" }];
  rows.rent_payments = [{ id: "pay1", amount: 5000, month: "2026-10", property_id: "p1" }];
  rows.expenses = [{ amount: 1200, category: "food", property_id: "p1" }];
  rows.complaints = [];
  rows.vacancy_notices = [];
});

describe("useDashboardData", () => {
  it("sends every read at once: none waits for the property list (no waterfall)", async () => {
    autoAnswer = false;
    renderHook(() => useDashboardData(owner), newClient());
    await waitFor(() => expect(sent.length).toBe(10));
    // All 10 went out before a single answer came back.
    expect(sent.filter((s) => s.table === "properties").length).toBe(2); // names list + count
    expect(sent.filter((s) => s.table === "rent_payments").length).toBe(2);
    act(() => sent.forEach((s) => s.resolve()));
  });

  it("scopes every stats read to the accessible properties", async () => {
    const { result } = renderHook(() => useDashboardData(owner), newClient());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    const statsReads = sent.filter((s) => !(s.table === "properties" && s.filters.includes("owner_id=owner-1")));
    for (const s of statsReads) expect(s.filters.some((f) => f.endsWith(" in p1,p2"))).toBe(true);
  });

  it("a staff member locked to one property only reads that property", async () => {
    const { result } = renderHook(() => useDashboardData({ ...owner, staffPropertyId: "p2" }), newClient());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    const statsReads = sent.filter((s) => !s.filters.includes("owner_id=owner-1"));
    expect(statsReads.length).toBe(9);
    for (const s of statsReads) expect(s.filters.some((f) => f.endsWith(" in p2"))).toBe(true);
  });

  it("computes the KPIs the cards show", async () => {
    const { result } = renderHook(() => useDashboardData(owner), newClient());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    const d = result.current.data!;
    expect(d.stats.properties).toBe(2);
    expect(d.stats.tenants).toBe(2);
    expect(d.occupancy).toEqual({ occupied: 2, vacant: 1 });
    expect(d.stats.totalExpenses).toBe(1200);
    expect(result.current.properties).toEqual(rows.properties);
  });

  it("coming back to the dashboard paints the last numbers at once, then refreshes them exactly once", async () => {
    const client = newClient();
    const first = renderHook(() => useDashboardData(owner), client);
    await waitFor(() => expect(first.result.current.isLoading).toBe(false));
    first.unmount();
    // The owner opens another page and comes back a moment later.
    await new Promise((r) => setTimeout(r, 30));
    sent.length = 0;

    const again = renderHook(() => useDashboardData(owner), client);
    // No skeleton on the revisit: cached KPIs are there on the first render.
    expect(again.result.current.isLoading).toBe(false);
    expect(again.result.current.data?.stats.tenants).toBe(2);
    // Money can be stale, so the 9 stats reads always run again; the property names list is not refetched.
    await waitFor(() => expect(sent.length).toBe(9));
    await new Promise((r) => setTimeout(r, 50));
    expect(sent.length).toBe(9);
  });

  it("a failed read is an error, never zeros (zeros would show 'Setup Your PG' to a real owner)", async () => {
    failTable = "tenant_assignments";
    const { result } = renderHook(() => useDashboardData(owner), newClient());
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toBeUndefined();
  });

  it("switching the filter while offline shows the error, never the previous filter's numbers as if they were this one's", async () => {
    let opts = owner;
    const client = newClient();
    const result = { current: undefined as unknown as ReturnType<typeof useDashboardData> };
    const Probe = () => { result.current = useDashboardData(opts); return null; };
    let root: Root;
    const el = document.createElement("div");
    act(() => { root = createRoot(el); root.render(<QueryClientProvider client={client}><Probe /></QueryClientProvider>); });
    await waitFor(() => expect(result.current.data?.stats.tenants).toBe(2));

    failTable = "tenant_assignments"; // the network drops
    autoAnswer = false;
    opts = { ...owner, filterPropertyId: "p2" };
    act(() => root.render(<QueryClientProvider client={client}><Probe /></QueryClientProvider>));
    // While "p2" loads, the previous numbers stay on screen (keepPreviousData): no blank flash.
    expect(result.current.data?.stats.tenants).toBe(2);
    await waitFor(() => expect(sent.filter((s) => s.filters.includes("property_id in p2")).length).toBeGreaterThan(0));
    act(() => sent.forEach((s) => s.resolve()));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toBeUndefined(); // "all"'s numbers must not be shown under the "p2" filter
    act(() => root.unmount());
  });

  it("an owner with no properties gets an empty dashboard without any stats reads", async () => {
    rows.properties = [];
    const { result } = renderHook(() => useDashboardData({ ...owner, accessiblePropertyIds: [] }), newClient());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.data?.stats.properties).toBe(0);
    expect(sent.filter((s) => s.table !== "properties").length).toBe(0);
  });

  it("does not read anything until access is known", async () => {
    renderHook(() => useDashboardData({ ...owner, enabled: false }), newClient());
    await new Promise((r) => setTimeout(r, 30));
    expect(sent.length).toBe(0);
  });
});
