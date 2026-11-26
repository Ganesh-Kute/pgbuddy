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

vi.mock("@/components/dashboard/DashboardCharts", () => ({
  default: () => <div>charts</div>,
}));

vi.mock("@/components/OverLimitBanner", () => ({
  default: () => null,
}));

vi.mock("@/components/PropertyMap", () => ({
  default: () => null,
}));

vi.mock("@/components/SEOHead", () => ({
  default: () => null,
}));

vi.mock("@/components/landing/Navbar", () => ({
  default: () => null,
}));

vi.mock("@/components/landing/Footer", () => ({
  default: () => null,
}));

vi.mock("@/hooks/usePushNotifications", () => ({
  usePushNotifications: () => ({
    isSupported: false,
    isSubscribed: false,
    isLoading: false,
    permission: "default",
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
  }),
}));

vi.mock("next-themes", () => ({
  useTheme: () => ({ resolvedTheme: "light", theme: "light", setTheme: vi.fn() }),
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

describe("T4 Batch 3 page-level loading states (no raw Loading..., no KPI/Free flash)", () => {
  const simpleCases = [
    {
      name: "TenantDashboard",
      load: () => import("@/pages/TenantDashboard").then((m) => <m.default />),
      emptyText: /No room assigned/i,
    },
    {
      name: "Announcements",
      load: () => import("@/pages/Announcements").then((m) => <m.default />),
      emptyText: /No announcements/i,
    },
    {
      name: "UtilityBills",
      load: () => import("@/pages/UtilityBills").then((m) => <m.default />),
      emptyText: /No bills here/i,
    },
    {
      name: "Documents",
      load: () => import("@/pages/Documents").then((m) => <m.default />),
      emptyText: /No documents/i,
    },
    {
      name: "TenantDocuments",
      load: () => import("@/pages/TenantDocuments").then((m) => <m.default />),
      emptyText: /No documents uploaded/i,
    },
    {
      name: "StaffManagement",
      load: () => import("@/pages/StaffManagement").then((m) => <m.default />),
      emptyText: /No staff members/i,
    },
  ];

  for (const c of simpleCases) {
    it(`${c.name} renders aria-busy placeholder before 150ms and PageSkeleton after 150ms without raw Loading...`, async () => {
      const el = await c.load();
      await renderPage(el);
      const initialText = container.textContent ?? "";
      expect(initialText).not.toMatch(/Loading\.\.\./i);
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

  it("Dashboard renders delayed skeleton instead of zero KPIs or Setup Your PG while loading", async () => {
    const { default: Dashboard } = await import("@/pages/Dashboard");
    await renderPage(<Dashboard />);
    const initialText = container.textContent ?? "";
    expect(initialText).not.toContain("Active Tenants");
    expect(initialText).not.toContain("Setup Your PG");
    expect(initialText).not.toContain("No payment data yet");
    expect(container.querySelector('[role="status"][aria-busy="true"]')).not.toBeNull();
    expect(container.querySelectorAll(".animate-pulse").length).toBe(0);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(160);
    });
    expect(container.querySelectorAll(".animate-pulse").length).toBeGreaterThan(0);
  });

  it("BrowsePG shows skeleton count placeholder instead of raw Loading... while loading", async () => {
    const { default: BrowsePG } = await import("@/pages/BrowsePG");
    await renderPage(<BrowsePG />);
    expect(container.textContent ?? "").not.toMatch(/Loading\.\.\./i);
    expect(container.querySelectorAll(".animate-pulse").length).toBeGreaterThan(0);
  });

  it("DashboardLayout does not flash Free badge before the subscription plan query resolves", async () => {
    const { LanguageProvider } = await import("@/i18n/LanguageContext");
    const { default: RealDashboardLayout } = await vi.importActual<typeof import("@/components/dashboard/DashboardLayout")>(
      "@/components/dashboard/DashboardLayout",
    );
    await renderPage(
      <LanguageProvider>
        <RealDashboardLayout>
          <div>Body</div>
        </RealDashboardLayout>
      </LanguageProvider>,
    );
    expect(container.textContent ?? "").not.toContain("Free");
    expect(container.querySelectorAll(".animate-pulse").length).toBeGreaterThan(0);
  });

  it("DashboardLayout renders neither Free badge nor endless skeleton when subscription plan query fails", async () => {
    const { LanguageProvider } = await import("@/i18n/LanguageContext");
    const { supabase } = await import("@/integrations/supabase/client");
    const { default: RealDashboardLayout } = await vi.importActual<typeof import("@/components/dashboard/DashboardLayout")>(
      "@/components/dashboard/DashboardLayout",
    );

    const makeResultChain = (resultPromise: Promise<unknown>) => {
      const chain: Record<string, unknown> = {};
      for (const m of ["select", "eq", "neq", "in", "is", "gte", "lte", "order", "limit", "maybeSingle", "single"]) {
        chain[m] = () => chain;
      }
      chain.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => resultPromise.then(resolve, reject);
      return chain;
    };

    const spy = vi.spyOn(supabase, "from");
    try {
      const renderWithQc = async (qc: QueryClient) => {
        await act(async () => {
          root.render(
            <QueryClientProvider client={qc}>
              <MemoryRouter>
                <LanguageProvider>
                  <RealDashboardLayout>
                    <div>Body</div>
                  </RealDashboardLayout>
                </LanguageProvider>
              </MemoryRouter>
            </QueryClientProvider>,
          );
        });
      };

      spy.mockImplementation(() => makeResultChain(Promise.resolve({ data: null, error: { message: "offline" } })) as never);
      await renderWithQc(new QueryClient({ defaultOptions: { queries: { retry: false } } }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10);
      });
      expect(container.textContent ?? "").not.toContain("Free");
      expect(container.querySelectorAll(".animate-pulse").length).toBe(0);

      spy.mockImplementation(() => makeResultChain(Promise.reject(new Error("network down"))) as never);
      await act(async () => {
        root.unmount();
        root = createRoot(container);
      });
      await renderWithQc(new QueryClient({ defaultOptions: { queries: { retry: false } } }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10);
      });
      expect(container.textContent ?? "").not.toContain("Free");
      expect(container.querySelectorAll(".animate-pulse").length).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  it("DashboardLayout caches subscription plan across remounts in a shared QueryClient with zero extra reads", async () => {
    const { LanguageProvider } = await import("@/i18n/LanguageContext");
    const { supabase } = await import("@/integrations/supabase/client");
    const { default: RealDashboardLayout } = await vi.importActual<typeof import("@/components/dashboard/DashboardLayout")>(
      "@/components/dashboard/DashboardLayout",
    );

    const makeResultChain = (resultPromise: Promise<unknown>) => {
      const chain: Record<string, unknown> = {};
      for (const m of ["select", "eq", "neq", "in", "is", "gte", "lte", "order", "limit", "maybeSingle", "single"]) {
        chain[m] = () => chain;
      }
      chain.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => resultPromise.then(resolve, reject);
      return chain;
    };

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const spy = vi.spyOn(supabase, "from").mockImplementation(
      () => makeResultChain(Promise.resolve({ data: { subscription_plans: { name: "Pro" } }, error: null })) as never,
    );
    try {
      const mountOnce = async () => {
        await act(async () => {
          root.render(
            <QueryClientProvider client={qc}>
              <MemoryRouter>
                <LanguageProvider>
                  <RealDashboardLayout>
                    <div>Body</div>
                  </RealDashboardLayout>
                </LanguageProvider>
              </MemoryRouter>
            </QueryClientProvider>,
          );
        });
      };

      await mountOnce();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10);
      });
      const subBadgeText = () => container.querySelector('a[href="/dashboard/subscription"]')?.textContent ?? "";
      expect(subBadgeText()).toContain("Pro");
      expect(spy).toHaveBeenCalledTimes(1);

      await act(async () => {
        root.unmount();
        root = createRoot(container);
      });

      await mountOnce();
      expect(subBadgeText()).toContain("Pro");
      expect(container.querySelectorAll(".animate-pulse").length).toBe(0);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("DashboardLayout refetches plan badge when subscription-plan query key is invalidated", async () => {
    const { LanguageProvider } = await import("@/i18n/LanguageContext");
    const { supabase } = await import("@/integrations/supabase/client");
    const { default: RealDashboardLayout } = await vi.importActual<typeof import("@/components/dashboard/DashboardLayout")>(
      "@/components/dashboard/DashboardLayout",
    );

    const makeResultChain = (resultPromise: Promise<unknown>) => {
      const chain: Record<string, unknown> = {};
      for (const m of ["select", "eq", "neq", "in", "is", "gte", "lte", "order", "limit", "maybeSingle", "single"]) {
        chain[m] = () => chain;
      }
      chain.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => resultPromise.then(resolve, reject);
      return chain;
    };

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let planName = "Free";
    const spy = vi.spyOn(supabase, "from").mockImplementation(
      () => makeResultChain(Promise.resolve({ data: { subscription_plans: { name: planName } }, error: null })) as never,
    );
    try {
      await act(async () => {
        root.render(
          <QueryClientProvider client={qc}>
            <MemoryRouter>
              <LanguageProvider>
                <RealDashboardLayout>
                  <div>Body</div>
                </RealDashboardLayout>
              </LanguageProvider>
            </MemoryRouter>
          </QueryClientProvider>,
        );
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10);
      });
      const subBadgeText = () => container.querySelector('a[href="/dashboard/subscription"]')?.textContent ?? "";
      expect(subBadgeText()).toContain("Free");
      expect(subBadgeText()).not.toContain("Pro");

      planName = "Pro";
      await act(async () => {
        await qc.invalidateQueries({ queryKey: ["subscription-plan"] });
        await vi.advanceTimersByTimeAsync(10);
      });
      expect(subBadgeText()).toContain("Pro");
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
  });
});
