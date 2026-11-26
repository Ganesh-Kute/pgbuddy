import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import DashboardLayout from "@/components/dashboard/DashboardLayout";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({
    user: { id: "u1", email: "owner@example.com" },
    session: { user: { id: "u1" } },
    role: "owner",
    isStaff: false,
    accessFailed: false,
    loading: false,
    signOut: vi.fn(async () => {}),
    refreshRole: vi.fn(async () => {}),
    recheckSession: vi.fn(async () => {}),
  }),
}));

vi.mock("@/hooks/useStaffAccess", () => ({
  useStaffAccess: () => ({
    effectiveOwnerId: "u1",
    isStaff: false,
    staffPropertyId: null,
    accessiblePropertyIds: ["p1"],
    loading: false,
  }),
}));

vi.mock("@/hooks/useSubscriptionGuard", () => ({
  useSubscriptionGuard: () => ({
    planSlug: "free",
    limits: {
      slug: "free",
      name: "Free",
      maxPhotos: 3,
      videoTour: false,
      enquiryAnalytics: false,
      featuredBadge: false,
      tenantLimit: 5,
    },
    bedCount: 0,
    bedLimit: 5,
    isOverLimit: false,
    isReadOnly: false,
    isBedLimitReached: false,
    refetchBedCount: vi.fn(),
    loading: false,
  }),
}));

vi.mock("@/hooks/useSubscriptionPlan", () => ({
  useSubscriptionPlan: () => ({
    planSlug: "free",
    limits: {
      slug: "free",
      name: "Free",
      maxPhotos: 3,
      videoTour: false,
      enquiryAnalytics: false,
      featuredBadge: false,
      tenantLimit: 5,
    },
    loading: false,
    isPro: false,
    isBusiness: false,
    isEnterprise: false,
    canUseWhatsApp: () => true,
  }),
}));

vi.mock("@/components/dashboard/DashboardLayout", () => ({
  default: ({ children }: { children: ReactNode }) => <div data-testid="layout">{children}</div>,
}));

vi.mock("@/components/dashboard/TenantLayout", () => ({
  default: ({ children }: { children: ReactNode }) => <div data-testid="tenant-layout">{children}</div>,
}));

vi.mock("@/integrations/supabase/client", () => {
  const never = () => new Promise(() => {});
  const makeChain = () => {
    const chain: Record<string, unknown> = {};
    for (const m of ["select", "eq", "neq", "in", "is", "gte", "lte", "order", "limit", "maybeSingle", "single"]) {
      chain[m] = () => chain;
    }
    chain.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => never().then(resolve, reject);
    return chain;
  };
  return {
    supabase: {
      from: () => makeChain(),
      rpc: () => never(),
      auth: { getUser: never, getSession: never },
    },
  };
});

let container: HTMLDivElement;
let root: Root;

async function renderPage(node: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>{node}</MemoryRouter>
      </QueryClientProvider>,
    );
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe("DelayedPageSkeleton", () => {
  it("reserves busy space before 150ms, renders PageSkeleton after 150ms, and never flickers when cleared early", async () => {
    const { DelayedPageSkeleton, PAGE_SKELETON_DELAY_MS } = await import("@/components/ui/DelayedPageSkeleton");
    await renderPage(<DelayedPageSkeleton loading={true} variant="cards" count={4} />);
    expect(container.querySelector('[role="status"][aria-busy="true"]')).not.toBeNull();
    expect(container.querySelectorAll(".animate-pulse").length).toBe(0);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(PAGE_SKELETON_DELAY_MS);
    });
    expect(container.querySelectorAll(".animate-pulse").length).toBeGreaterThan(0);

    await renderPage(<DelayedPageSkeleton loading={false} variant="cards" count={4} />);
    expect(container.querySelector('[role="status"]')).toBeNull();
  });
});

describe("T4 Batch 1 page-level loading states (no raw Loading... and no empty-state flash)", () => {
  const cases = [
    {
      name: "Rooms",
      load: () => import("@/pages/Rooms").then((m) => <m.default />),
      emptyText: /No rooms yet/i,
    },
    {
      name: "Payments",
      load: () => import("@/pages/Payments").then((m) => <m.default />),
      emptyText: /No payments recorded/i,
    },
    {
      name: "Complaints",
      load: () => import("@/pages/Complaints").then((m) => <m.default />),
      emptyText: /No complaints/i,
    },
    {
      name: "Notices",
      load: () => import("@/pages/Notices").then((m) => <m.default />),
      emptyText: /No vacancy notices/i,
    },
    {
      name: "Expenses",
      load: () => import("@/pages/Expenses").then((m) => <m.default />),
      emptyText: /No expenses recorded/i,
    },
    {
      name: "PaymentSettings",
      load: () => import("@/pages/PaymentSettings").then((m) => <m.default />),
      emptyText: /Select Property scope/i,
    },
    {
      name: "VisitorLog",
      load: () => import("@/pages/VisitorLog").then((m) => <m.default />),
      emptyText: /No visitor entries/i,
    },
    {
      name: "AuditLogs",
      load: () => import("@/pages/AuditLogs").then((m) => <m.default />),
      emptyText: /No activity yet/i,
    },
    {
      name: "ProfileSettings",
      load: () => import("@/pages/ProfileSettings").then((m) => <m.default Layout={DashboardLayout} />),
      emptyText: /Your Profile/i,
    },
    {
      name: "Subscription",
      load: () => import("@/pages/Subscription").then((m) => <m.default />),
      emptyText: /Monthly/i,
      checkAfterTextOnly: true,
    },
  ];

  for (const c of cases) {
    it(`${c.name} renders aria-busy placeholder before 150ms and PageSkeleton after 150ms without raw Loading...`, async () => {
      const el = await c.load();
      await renderPage(el);
      const initialText = container.textContent ?? "";
      expect(initialText).not.toMatch(/Loading(\.\.\.| activity\.\.\.)/i);
      if (!c.checkAfterTextOnly) {
        expect(initialText).not.toMatch(c.emptyText);
      }
      expect(container.querySelector('[role="status"][aria-busy="true"]')).not.toBeNull();
      expect(container.querySelectorAll(".animate-pulse").length).toBe(0);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(160);
      });
      expect(container.querySelector('[role="status"][aria-busy="true"]')).not.toBeNull();
      expect(container.querySelectorAll(".animate-pulse").length).toBeGreaterThan(0);
    });
  }
});

describe("T4 Batch 2 page-level loading states (no raw Loading... and no empty-state flash)", () => {
  const cases = [
    {
      name: "Marketplace",
      load: () => import("@/pages/Marketplace").then((m) => <m.default />),
      emptyText: /No PGs found/i,
    },
    {
      name: "TenantInvitations",
      load: () => import("@/pages/TenantInvitations").then((m) => <m.default />),
      emptyText: /No invitations/i,
    },
    {
      name: "TenantPayments",
      load: () => import("@/pages/TenantPayments").then((m) => <m.default />),
      emptyText: /No payment records/i,
    },
    {
      name: "TenantComplaints",
      load: () => import("@/pages/TenantComplaints").then((m) => <m.default />),
      emptyText: /No complaints filed/i,
    },
    {
      name: "TenantNotices",
      load: () => import("@/pages/TenantNotices").then((m) => <m.default />),
      emptyText: /No vacancy notices/i,
    },
    {
      name: "TenantAnnouncements",
      load: () => import("@/pages/TenantAnnouncements").then((m) => <m.default />),
      emptyText: /No announcements/i,
    },
    {
      name: "TenantOnboarding",
      load: () => import("@/pages/TenantOnboarding").then((m) => <m.default />),
      emptyText: /Welcome Onboarding/i,
    },
    {
      name: "TenantUtilityBills",
      load: () => import("@/pages/TenantUtilityBills").then((m) => <m.default />),
      emptyText: /No utility bills/i,
    },
    {
      name: "TenantAnalytics",
      load: () => import("@/pages/TenantAnalytics").then((m) => <m.default />),
      emptyText: /move-ins \/ move-outs/i,
    },
    {
      name: "TenantMoveOut",
      load: () => import("@/pages/TenantMoveOut").then((m) => <m.default />),
      emptyText: /No active room assignment found/i,
    },
    {
      name: "MessAttendance",
      load: () => import("@/pages/MessAttendance").then((m) => <m.default />),
      emptyText: /No Active Members/i,
    },
  ];

  for (const c of cases) {
    it(`${c.name} renders aria-busy placeholder before 150ms and PageSkeleton after 150ms without raw Loading...`, async () => {
      const el = await c.load();
      await renderPage(el);
      const initialText = container.textContent ?? "";
      expect(initialText).not.toMatch(/Loading(\.\.\.| listings\.\.\.| analytics\.\.\.)/i);
      expect(initialText).not.toMatch(c.emptyText);
      expect(container.querySelector('[role="status"][aria-busy="true"]')).not.toBeNull();
      expect(container.querySelectorAll(".animate-pulse").length).toBe(0);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(160);
      });
      expect(container.querySelector('[role="status"][aria-busy="true"]')).not.toBeNull();
      expect(container.querySelectorAll(".animate-pulse").length).toBeGreaterThan(0);
    });
  }
});
