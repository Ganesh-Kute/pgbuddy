import fs from "node:fs";
import path from "node:path";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

const AUTH_STATE = { user: { id: "user-1", email: "owner@example.com" }, loading: false, signOut: vi.fn() };
const STAFF_ACCESS = { isStaff: false, effectiveOwnerId: "user-1", staffPropertyId: null, accessiblePropertyIds: ["prop-1"], loading: false };
const SUB_GUARD = { isOverLimit: false, bedCount: 2, bedLimit: 10, limits: { name: "Pro", videoTour: true, maxPhotos: 10 } };
const SUB_PLAN = { planName: "Pro", isPro: true, isBusiness: true, limits: { name: "Pro", videoTour: true, maxPhotos: 10 }, loading: false };
const WA_NOTIFY = { notify: vi.fn(), send: vi.fn(), sendWhatsApp: vi.fn() };
const PUSH_STATE = { isSupported: false, isSubscribed: false, isLoading: false, permission: "default", subscribe: vi.fn(), unsubscribe: vi.fn() };

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => false },
}));

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => AUTH_STATE,
}));

vi.mock("@/hooks/useStaffAccess", () => ({
  useStaffAccess: () => STAFF_ACCESS,
}));

vi.mock("@/hooks/useSubscriptionGuard", () => ({
  useSubscriptionGuard: () => SUB_GUARD,
}));

vi.mock("@/hooks/useSubscriptionPlan", () => ({
  useSubscriptionPlan: () => SUB_PLAN,
}));

vi.mock("@/hooks/useWhatsAppNotify", () => ({
  useWhatsAppNotify: () => WA_NOTIFY,
}));

vi.mock("@/hooks/usePushNotifications", () => ({
  usePushNotifications: () => PUSH_STATE,
}));

const PROPS_ROWS = [{ id: "prop-1", name: "Mauli Executive Residency Boys & Girls PG", owner_id: "user-1" }, { id: "prop-2", name: "Shivneri Hostel", owner_id: "user-1" }];
const ANN_ROWS = [{ id: "a1", title: "Water cleaning", content: "Sunday 9am", priority: "normal", is_active: true, created_at: "2026-11-20T00:00:00Z", properties: { name: "Mauli Executive Residency Boys & Girls PG" } }];
const ASSIGN_ROWS = [{ id: "ta-1", property_id: "prop-1", room_id: "r-1", tenant_id: "user-1", properties: { name: "Mauli PG" }, rooms: { room_number: "101" } }];

function makeChain(rows: unknown[] = []) {
  const result = { data: rows, error: null, count: rows.length };
  const chain: Record<string, unknown> = {
    select: () => chain,
    eq: () => chain,
    neq: () => chain,
    in: () => chain,
    gte: () => chain,
    lte: () => chain,
    order: () => chain,
    limit: () => chain,
    maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
    single: async () => ({ data: rows[0] ?? null, error: null }),
    then: (resolve: (v: unknown) => void) => Promise.resolve(result).then(resolve),
  };
  return chain;
}

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (table: string) => {
      if (table === "properties") return makeChain(PROPS_ROWS);
      if (table === "announcements") return makeChain(ANN_ROWS);
      if (table === "tenant_assignments") return makeChain(ASSIGN_ROWS);
      return makeChain([]);
    },
    channel: () => ({ on: () => ({ subscribe: () => ({}) }) }),
    removeChannel: vi.fn(),
  },
}));

vi.mock("next-themes", () => ({
  useTheme: () => ({ resolvedTheme: "light", theme: "light", setTheme: vi.fn() }),
}));

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LanguageProvider } from "@/i18n/LanguageContext";
import DashboardLayout from "@/components/dashboard/DashboardLayout";
import TenantLayout from "@/components/dashboard/TenantLayout";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import Announcements from "@/pages/Announcements";
import UtilityBills from "@/pages/UtilityBills";
import Documents from "@/pages/Documents";
import TenantDocuments from "@/pages/TenantDocuments";
import StaffManagement from "@/pages/StaffManagement";
import MoveOutManagement from "@/pages/MoveOutManagement";
import ManageListing from "@/pages/ManageListing";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const ROOT = path.resolve(__dirname, "../..");

function renderNode(node: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <QueryClientProvider client={qc}>
        <LanguageProvider>
          <MemoryRouter>{node}</MemoryRouter>
        </LanguageProvider>
      </QueryClientProvider>,
    );
  });
  return {
    container,
    cleanup: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

describe("T3 mobile layout overflow & 44px tap targets", () => {
  it("DashboardLayout and TenantLayout set min-w-0 on <main> so long content cannot push viewport past 360px", () => {
    const d = renderNode(<DashboardLayout><div>Body</div></DashboardLayout>);
    try {
      expect(d.container.querySelector("main")?.className).toContain("min-w-0");
    } finally {
      d.cleanup();
    }

    const t = renderNode(<TenantLayout><div>Body</div></TenantLayout>);
    try {
      expect(t.container.querySelector("main")?.className).toContain("min-w-0");
    } finally {
      t.cleanup();
    }
  });

  it("TabsList wraps on narrow viewports and stays within max-w-full", () => {
    const r = renderNode(
      <Tabs defaultValue="a">
        <TabsList>
          <TabsTrigger value="a">Pending (0)</TabsTrigger>
          <TabsTrigger value="b">In Progress (0)</TabsTrigger>
          <TabsTrigger value="c">Completed (0)</TabsTrigger>
        </TabsList>
      </Tabs>,
    );
    try {
      const list = r.container.querySelector("[role=\"tablist\"]");
      expect(list?.className).toContain("flex-wrap");
      expect(list?.className).toContain("max-w-full");
      expect(list?.className).toContain("h-auto");
    } finally {
      r.cleanup();
    }
  });

  it.each([
    ["Announcements", () => <Announcements />],
    ["UtilityBills", () => <UtilityBills />],
    ["Documents", () => <Documents />],
    ["TenantDocuments", () => <TenantDocuments />],
    ["StaffManagement", () => <StaffManagement />],
    ["MoveOutManagement", () => <MoveOutManagement />],
    ["ManageListing", () => <ManageListing />],
  ])("%s header wraps on 360px mobile", async (name, makeEl) => {
    const r = renderNode(makeEl());
    try {
      await act(async () => {
        await Promise.resolve();
      });
      const h1 = r.container.querySelector("h1");
      expect(h1, name + " renders h1").toBeTruthy();
      const headerRow = h1?.parentElement?.parentElement;
      if (headerRow && headerRow.className.includes("justify-between")) {
        expect(
          headerRow.className.includes("flex-wrap") || headerRow.className.includes("flex-col"),
          name + " header must wrap on 360px mobile",
        ).toBe(true);
      }
    } finally {
      r.cleanup();
    }
  });

  it("Icon action buttons on Announcements, MoveOutManagement, and ManageListing preserve >=44px mobile touch targets", () => {
    const checks = [
      { file: "src/pages/Announcements.tsx", bad: "h-7 w-7 text-destructive" },
      { file: "src/pages/MoveOutManagement.tsx", bad: "className=\"h-6 w-6\"" },
      { file: "src/pages/ManageListing.tsx", bad: "className=\"h-8 w-8\"" },
    ];
    for (const c of checks) {
      const src = fs.readFileSync(path.join(ROOT, c.file), "utf8");
      expect(src, c.file + " must not shrink icon buttons below 44px on mobile").not.toContain(c.bad);
    }
  });

  it("ManageListing photo actions stay visible on touch/landscape/tablet devices and use hover media + focus-within", () => {
    const src = fs.readFileSync(path.join(ROOT, "src/pages/ManageListing.tsx"), "utf8");
    expect(src).not.toContain("sm:opacity-0");
    expect(src).not.toContain("sm:group-hover:opacity-100");
    expect(src).toContain("opacity-100");
    expect(src).toContain("[@media(hover:hover)]:opacity-0");
    expect(src).toContain("[@media(hover:hover)]:group-hover:opacity-100");
    expect(src).toContain("focus-within:opacity-100");
  });

  it("getAppLogo returns an existing non-404 asset in public/ by default", async () => {
    const { getAppLogo } = await import("@/lib/branding");
    const logo = getAppLogo();
    expect(logo).toBe("/pwa-icon-192.png");
    const assetPath = path.join(ROOT, "public", logo.replace(/^\//, ""));
    expect(fs.existsSync(assetPath)).toBe(true);
  });

  it("buttonVariants size=sm preserves >=44px mobile touch height", async () => {
    const { buttonVariants } = await import("@/components/ui/button");
    const cls = buttonVariants({ size: "sm" });
    expect(cls).toContain("min-h-[44px]");
  });

  it("Properties, Tenants, and Mess pages preserve >=44px mobile icon targets and wrap narrow headers/rows", () => {
    const targetFiles = [
      "src/pages/Properties.tsx",
      "src/pages/Tenants.tsx",
      "src/pages/MessPlans.tsx",
      "src/pages/MessMembers.tsx",
      "src/pages/MessPayments.tsx",
      "src/pages/MessGuests.tsx",
      "src/pages/MessExpenses.tsx",
    ];
    const bareIconRe = /className="[^"]*\bh-[678] w-[678]\b/;
    for (const rel of targetFiles) {
      const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
      const lines = src.split(/\r?\n/);
      for (const line of lines) {
        if (bareIconRe.test(line)) {
          expect(line, rel + " bare small icon target: " + line.trim()).toContain("min-h-[44px]");
        }
      }
    }
    const messPlans = fs.readFileSync(path.join(ROOT, "src/pages/MessPlans.tsx"), "utf8");
    expect(messPlans).toContain("justify-between flex-wrap");
    const messPayments = fs.readFileSync(path.join(ROOT, "src/pages/MessPayments.tsx"), "utf8");
    expect(messPayments).not.toContain('<div className="flex gap-2 items-center">');
    const messMembers = fs.readFileSync(path.join(ROOT, "src/pages/MessMembers.tsx"), "utf8");
    expect(messMembers).not.toContain('className="py-3 flex items-center justify-between gap-4"');
    const messGuests = fs.readFileSync(path.join(ROOT, "src/pages/MessGuests.tsx"), "utf8");
    expect(messGuests).not.toContain('className="flex items-center justify-between p-3 border');
    const messExpenses = fs.readFileSync(path.join(ROOT, "src/pages/MessExpenses.tsx"), "utf8");
    expect(messExpenses).not.toContain('className="flex items-center justify-between p-3 border');
  });

  it("PublicReceipt uses semantic theme tokens, white-label getAppName, and mobile padding", () => {
    const src = fs.readFileSync(path.join(ROOT, "src/pages/PublicReceipt.tsx"), "utf8");
    expect(src).toContain("getAppName");
    expect(src).not.toContain("signed by PG Buddy");
    expect(src).not.toContain("Powered by PG Buddy");
    expect(src).not.toContain("🏠 PG Buddy");
    expect(src).not.toMatch(/(?<!print:)bg-slate-50/);
    expect(src).toContain("bg-background");
    expect(src).toContain("bg-card");
    expect(src).toContain("p-5 sm:p-12");
  });
});
