import fs from "node:fs";
import path from "node:path";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

const isNativeMock = vi.fn(() => false);
vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => isNativeMock() },
}));

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({
    user: { id: "user-1", email: "owner@example.com" },
    loading: false,
    signOut: vi.fn(),
  }),
}));

vi.mock("@/hooks/useStaffAccess", () => ({
  useStaffAccess: () => ({
    isStaff: false,
    effectiveOwnerId: "user-1",
    loading: false,
  }),
}));

vi.mock("@/hooks/usePushNotifications", () => ({
  usePushNotifications: () => ({
    isSupported: true,
    isSubscribed: false,
    isLoading: false,
    permission: "default",
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
  }),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: null, error: null }),
          }),
          order: () => ({
            limit: async () => ({ data: [], error: null }),
          }),
        }),
      }),
      update: () => ({ eq: () => ({ eq: async () => ({ error: null }) }) }),
    }),
    channel: () => ({
      on: () => ({ subscribe: () => ({}) }),
    }),
    removeChannel: vi.fn(),
  },
}));

vi.mock("next-themes", () => ({
  useTheme: () => ({
    resolvedTheme: "light",
    theme: "light",
    setTheme: vi.fn(),
  }),
}));

import { LanguageProvider, useLanguage } from "@/i18n/LanguageContext";
import { loadLanguage, en } from "@/i18n/translations";
import DashboardLayout from "@/components/dashboard/DashboardLayout";
import TenantLayout from "@/components/dashboard/TenantLayout";
import InstallPWA from "@/components/InstallPWA";
import Footer from "@/components/landing/Footer";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const ROOT = path.resolve(__dirname, "../..");

function renderIntoContainer(node: React.ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(node);
  });
  return {
    container,
    cleanup: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

function I18nProbe() {
  const { language, setLanguage, t } = useLanguage();
  return (
    <div>
      <span data-testid="lang">{language}</span>
      <span data-testid="overview">{t("sidebar.overview")}</span>
      <button type="button" onClick={() => setLanguage("hi")}>
        SwitchHindi
      </button>
    </div>
  );
}

describe("Track P4: i18n lazy loading, mobile layouts, touch targets, and reduced motion", () => {
  it("loads only English synchronously and dynamically loads non-English locales on demand", async () => {
    const translationsSrc = fs.readFileSync(path.join(ROOT, "src/i18n/translations.ts"), "utf8");
    expect(translationsSrc).not.toContain('"संक्षिप्त"');
    expect(translationsSrc).toContain('import("./locales/hi")');
    expect(en["sidebar.overview"]).toBe("Overview");

    const hi = await loadLanguage("hi");
    expect(hi["sidebar.overview"]).toBeTruthy();
    expect(hi["sidebar.overview"]).not.toBe("Overview");

    localStorage.removeItem("pg-lang");
    const { container, cleanup } = renderIntoContainer(
      <LanguageProvider>
        <I18nProbe />
      </LanguageProvider>,
    );

    try {
      expect(container.querySelector('[data-testid="overview"]')?.textContent).toBe("Overview");
      const btn = container.querySelector("button")!;
      await act(async () => {
        btn.click();
        await Promise.resolve();
      });

      await vi.waitFor(() => {
        expect(container.querySelector('[data-testid="lang"]')?.textContent).toBe("hi");
        expect(container.querySelector('[data-testid="overview"]')?.textContent).toBe(hi["sidebar.overview"]);
      });
    } finally {
      cleanup();
    }
  });

  it("DashboardLayout renders thumb-reachable mobile bottom nav, 44px touch targets, safe areas, and zero framer-motion", () => {
    const src = fs.readFileSync(path.join(ROOT, "src/components/dashboard/DashboardLayout.tsx"), "utf8");
    expect(src).not.toContain("framer-motion");
    expect(src).toContain("pt-safe");
    expect(src).toContain("pb-safe");

    const { container, cleanup } = renderIntoContainer(
      <MemoryRouter initialEntries={["/dashboard"]}>
        <DashboardLayout>
          <div>DashboardBody</div>
        </DashboardLayout>
      </MemoryRouter>,
    );

    try {
      const bottomNav = container.querySelector('nav[aria-label="Mobile bottom navigation"]');
      expect(bottomNav).toBeTruthy();
      const moreBtn = container.querySelector('button[aria-label="More navigation"]');
      expect(moreBtn?.className).toContain("min-h-[48px]");
      const menuBtn = container.querySelector('button[aria-label="Open menu"]');
      expect(menuBtn?.className).toContain("min-h-[44px]");
    } finally {
      cleanup();
    }
  });

  it("TenantLayout renders thumb-reachable mobile bottom nav, 44px touch targets, and zero framer-motion", () => {
    const src = fs.readFileSync(path.join(ROOT, "src/components/dashboard/TenantLayout.tsx"), "utf8");
    expect(src).not.toContain("framer-motion");

    const { container, cleanup } = renderIntoContainer(
      <MemoryRouter initialEntries={["/tenant"]}>
        <TenantLayout>
          <div>TenantBody</div>
        </TenantLayout>
      </MemoryRouter>,
    );

    try {
      const bottomNav = container.querySelector('nav[aria-label="Mobile bottom navigation"]');
      expect(bottomNav).toBeTruthy();
      const moreBtn = container.querySelector('button[aria-label="More navigation"]');
      expect(moreBtn?.className).toContain("min-h-[48px]");
    } finally {
      cleanup();
    }
  });

  it("InstallPWA hides web install prompt inside native Capacitor shell", () => {
    isNativeMock.mockReturnValue(true);
    const { container, cleanup } = renderIntoContainer(<InstallPWA />);
    try {
      expect(container.firstChild).toBeNull();
    } finally {
      isNativeMock.mockReturnValue(false);
      cleanup();
    }
  });

  it("Footer uses fixed dark surface classes instead of bg-foreground (avoiding white block in dark mode)", () => {
    const { container, cleanup } = renderIntoContainer(
      <MemoryRouter>
        <Footer />
      </MemoryRouter>,
    );
    try {
      const footerEl = container.querySelector("footer");
      expect(footerEl?.className).not.toContain("bg-foreground");
      expect(footerEl?.className).toContain("bg-[#0f0b1f]");
    } finally {
      cleanup();
    }
  });

  it("src/index.css defines safe-area helpers, color-scheme, and prefers-reduced-motion rules", () => {
    const css = fs.readFileSync(path.join(ROOT, "src/index.css"), "utf8");
    expect(css).toContain("color-scheme: dark");
    expect(css).toContain("env(safe-area-inset-top");
    expect(css).toContain("env(safe-area-inset-bottom");
    expect(css).toContain("prefers-reduced-motion: reduce");
    expect(css).toContain("overflow-x: clip");
  });
});
