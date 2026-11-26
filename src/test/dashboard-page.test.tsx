import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// The real Dashboard page, rendered twice in one QueryClient, with a Supabase stand-in that counts requests.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const sent: string[] = [];
const rows: Record<string, unknown[]> = {};
vi.mock("@/integrations/supabase/client", () => {
  const chain = (table: string) => {
    let head = false;
    const q: Record<string, unknown> = {
      select: (_c: string, opts?: { head?: boolean }) => { head = !!opts?.head; return q; },
      eq: () => q, in: () => q, gte: () => q, lte: () => q, order: () => q, limit: () => q,
      then: (resolve: (v: unknown) => void) => {
        sent.push(table);
        resolve(head ? { data: null, error: null, count: (rows[table] ?? []).length } : { data: rows[table] ?? [], error: null });
      },
    };
    return q;
  };
  return { supabase: { from: (t: string) => chain(t) } };
});

let access = { effectiveOwnerId: "owner-1" as string | null, isStaff: false, staffPropertyId: null as string | null, accessiblePropertyIds: ["p1", "p2"], loading: false, failed: false };
vi.mock("@/hooks/useStaffAccess", () => ({ useStaffAccess: () => access, staffAccessKey: (id: string | null) => ["staff-access", id] }));
vi.mock("@/hooks/useSubscriptionGuard", () => ({ useSubscriptionGuard: () => ({ isOverLimit: false, bedCount: 0, bedLimit: 10, limits: { name: "Free" } }) }));
vi.mock("@/components/dashboard/DashboardLayout", () => ({ default: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock("@/components/OverLimitBanner", () => ({ default: () => null }));
vi.mock("@/components/dashboard/DashboardCharts", () => ({ default: () => <div>charts</div> }));

import Dashboard from "@/pages/Dashboard";

function mount(client: QueryClient) {
  const el = document.createElement("div");
  let root: Root;
  act(() => {
    root = createRoot(el);
    root.render(<QueryClientProvider client={client}><MemoryRouter><Dashboard /></MemoryRouter></QueryClientProvider>);
  });
  return { el, unmount: () => act(() => root.unmount()) };
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
/** The number shown on a stat card, by its label. */
const card = (el: HTMLElement, label: string) =>
  [...el.querySelectorAll("a")].find((a) => a.textContent?.includes(label))?.querySelector("p")?.textContent;

beforeEach(() => {
  sent.length = 0;
  access = { effectiveOwnerId: "owner-1", isStaff: false, staffPropertyId: null, accessiblePropertyIds: ["p1", "p2"], loading: false, failed: false };
  for (const k of Object.keys(rows)) delete rows[k];
  rows.properties = [{ id: "p1", name: "Shanti PG" }, { id: "p2", name: "Mauli PG" }];
  rows.rooms = [{ id: "r1", is_vacant: false, capacity: 3, property_id: "p1" }];
  rows.tenant_assignments = [{ id: "t1", property_id: "p1" }, { id: "t2", property_id: "p1" }];
});
afterEach(() => { vi.useRealTimers(); });

describe("Dashboard page", () => {
  it("a revisit later the same day paints the cached numbers at once (the date range does not change the cache key)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-26T10:00:00.123+05:30"));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const first = mount(client);
    await waitFor(() => expect(card(first.el, "Active Tenants")).toBe("2"));
    first.unmount();

    // The owner opens Payments and comes back 3 minutes later.
    vi.setSystemTime(new Date("2026-11-26T10:03:07.456+05:30"));
    sent.length = 0;
    const again = mount(client);
    expect(card(again.el, "Active Tenants")).toBe("2"); // first render, before any answer
    await waitFor(() => expect(sent.length).toBe(9)); // money is re-read once; property names are not
  });

  it("when the owner's property access cannot be read, it shows an error and Retry, never 'Setup Your PG' with zeros", async () => {
    access = { ...access, accessiblePropertyIds: [], failed: true };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { el } = mount(client);
    await new Promise((r) => setTimeout(r, 30));
    expect(el.textContent).toContain("Could not load your dashboard numbers");
    expect(el.textContent).not.toContain("Setup Your PG");
    expect(sent.filter((t) => t !== "properties").length).toBe(0); // no stats read with a half-known user
  });

  it("a real new owner (access read fine, no properties) still gets the setup card", async () => {
    access = { ...access, accessiblePropertyIds: [] };
    rows.properties = [];
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { el } = mount(client);
    await waitFor(() => expect(el.textContent).toContain("Setup Your PG"));
    expect(el.textContent).not.toContain("Could not load");
  });
});
