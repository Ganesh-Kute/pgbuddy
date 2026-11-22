import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  isNativeMock,
  invokeMock,
  toastMock,
  rentPaymentsData,
  assignmentsData,
} = vi.hoisted(() => ({
  isNativeMock: vi.fn(() => false),
  invokeMock: vi.fn(),
  toastMock: vi.fn(),
  rentPaymentsData: { current: [] as Record<string, unknown>[] },
  assignmentsData: { current: [] as Record<string, unknown>[] },
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => isNativeMock() },
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastMock }),
}));

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({
    user: {
      id: "owner-1",
      email: "user@example.com",
      user_metadata: { full_name: "Ravi Kumar" },
    },
    role: "owner",
    isStaff: false,
    loading: false,
    signOut: vi.fn(),
  }),
}));

vi.mock("@/hooks/useStaffAccess", () => ({
  useStaffAccess: () => ({
    isStaff: false,
    effectiveOwnerId: "owner-1",
    accessiblePropertyIds: ["prop-1"],
    loading: false,
  }),
}));

vi.mock("@/hooks/useSubscriptionPlan", () => ({
  useSubscriptionPlan: () => ({
    planSlug: "free",
    isPro: false,
    isBusiness: false,
    isEnterprise: false,
    canUseWhatsApp: (action: string) => action === "send-payment-receipt" || action === "send-payment-received" || action === "send-rent-reminder",
    loading: false,
  }),
}));

vi.mock("@/hooks/useSubscriptionGuard", () => ({
  useSubscriptionGuard: () => ({
    isReadOnly: false,
    isOverLimit: false,
    bedCount: 1,
    bedLimit: 5,
    limits: { name: "Free" },
  }),
}));

vi.mock("@/components/dashboard/DashboardLayout", () => ({
  default: ({ children }: { children: React.ReactNode }) => <div data-testid="dashboard-layout">{children}</div>,
}));

vi.mock("@/components/dashboard/TenantLayout", () => ({
  default: ({ children }: { children: React.ReactNode }) => <div data-testid="tenant-layout">{children}</div>,
}));

vi.mock("@/integrations/supabase/client", () => {
  const makeChain = (table: string) => {
    const chain: Record<string, unknown> = {};
    const resolveData = () => {
      if (table === "properties") {
        return { data: [{ id: "prop-1", name: "Sunrise PG", address: "MG Road" }], error: null };
      }
      if (table === "rent_payments") {
        return { data: rentPaymentsData.current, error: null };
      }
      if (table === "tenant_assignments") {
        return { data: assignmentsData.current, error: null };
      }
      if (table === "profiles") {
        return { data: [{ user_id: "tenant-1", full_name: "Ravi Kumar", phone: "9876543210" }], error: null };
      }
      return { data: [], error: null };
    };
    const promise = Promise.resolve().then(resolveData);
    chain.select = () => chain;
    chain.eq = () => chain;
    chain.in = () => chain;
    chain.is = () => chain;
    chain.order = () => chain;
    chain.limit = () => promise;
    chain.maybeSingle = () => Promise.resolve({ data: null, error: null });
    chain.update = () => ({ eq: () => Promise.resolve({ error: null }) });
    chain.insert = () => Promise.resolve({ error: null });
    chain.then = promise.then.bind(promise);
    return chain;
  };

  return {
    supabase: {
      from: (table: string) => makeChain(table),
      functions: {
        invoke: (...args: unknown[]) => invokeMock(...args),
      },
      storage: {
        from: () => ({
          upload: async () => ({ error: null }),
          getPublicUrl: () => ({ data: { publicUrl: "https://example.com/proof.png" } }),
        }),
      },
    },
  };
});

import RentReceipt from "@/components/RentReceipt";
import { formatReceiptWhatsAppFeedback, useWhatsAppNotify } from "@/hooks/useWhatsAppNotify";
import Payments from "@/pages/Payments";
import TenantPayments from "@/pages/TenantPayments";
import { buildReceipt } from "@/lib/receipt";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function renderNode(node: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>{node}</MemoryRouter>
      </QueryClientProvider>,
    );
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

async function flushUi() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 25));
  });
}

describe("Phase 3 Receipt UI & Hook", () => {
  beforeEach(() => {
    isNativeMock.mockReturnValue(false);
    invokeMock.mockReset();
    toastMock.mockReset();
    rentPaymentsData.current = [
      {
        id: "abcdef12-3456-7890-abcd-ef1234567890",
        tenant_id: "tenant-1",
        tenant_email: "ravi@example.com",
        tenant_name: "Ravi Kumar",
        tenant_phone: "9876543210",
        property_id: "prop-1",
        room_id: "room-1",
        amount: 12500,
        month: "2026-11",
        status: "paid",
        payment_type: "rent",
        payment_method: "upi",
        transaction_id: "UTR998877",
        payment_date: "2026-11-10T10:00:00.000Z",
        proof_url: null,
        proof_uploaded_at: null,
        rooms: { room_number: "101" },
        properties: { name: "Sunrise PG", address: "MG Road" },
      },
    ];
    assignmentsData.current = [];
  });

  it("formats via-specific WhatsApp receipt toasts accurately", () => {
    expect(formatReceiptWhatsAppFeedback({ sent: 1, via: "document" }).title).toBe("PDF sent");
    expect(formatReceiptWhatsAppFeedback({ sent: true, via: "template" }).title).toBe("PDF sent");
    expect(formatReceiptWhatsAppFeedback({ sent: 1, via: "link", reason: "offline" }).title).toBe(
      "Link sent (WhatsApp server offline)",
    );
    const notOnWa = formatReceiptWhatsAppFeedback({ sent: 0, statusCode: 404, reason: "not_on_whatsapp" });
    expect(notOnWa.title).toBe("Not on WhatsApp");
    expect(notOnWa.variant).toBe("destructive");
  });

  it("parses HTTP 404 errors in useWhatsAppNotify and downloads PDF blobs cleanly", async () => {
    let hookApi: ReturnType<typeof useWhatsAppNotify> | null = null;
    const Probe = () => {
      hookApi = useWhatsAppNotify();
      return null;
    };
    const view = renderNode(<Probe />);

    invokeMock.mockResolvedValueOnce({
      data: null,
      error: {
        message: "Edge Function returned a non-2xx status code",
        context: new Response(JSON.stringify({ error: "Not registered on WhatsApp" }), { status: 404 }),
      },
    });

    let sendRes: unknown = null;
    await act(async () => {
      sendRes = await hookApi!.send("send-payment-receipt", { payment_id: "pay-1" });
    });
    expect(sendRes).toMatchObject({ sent: 0, statusCode: 404, error: "Not registered on WhatsApp" });
    expect(formatReceiptWhatsAppFeedback(sendRes as never).title).toBe("Not on WhatsApp");

    const pdfBlob = new Blob(["%PDF-1.7\n"], { type: "application/pdf" });
    invokeMock.mockResolvedValueOnce({ data: pdfBlob, error: null });

    let dlRes: { blob?: Blob; error?: string } = {};
    await act(async () => {
      dlRes = await hookApi!.downloadReceiptPdf("pay-1");
    });
    expect(dlRes.error).toBeUndefined();
    expect(dlRes.blob).toBeInstanceOf(Blob);

    view.cleanup();
  });

  it("RentReceipt reads shared buildReceipt() model, renders deposit titles, and disables on non-paid rows", async () => {
    const unpaid = renderNode(
      <RentReceipt
        payment={{
          id: "abcdef12-3456-7890-abcd-ef1234567890",
          amount: 12500,
          month: "2026-11",
          payment_date: null,
          status: "pending",
        }}
      />,
    );
    expect(unpaid.container.textContent).toBe("");
    unpaid.cleanup();

    const payment = {
      id: "abcdef12-3456-7890-abcd-ef1234567890",
      amount: 15000,
      month: "2026-11",
      payment_date: "2026-11-10T10:00:00.000Z",
      status: "paid",
      payment_type: "deposit",
      payment_method: "bank_transfer",
      transaction_id: "TXN42",
      properties: { name: "Sunrise PG", address: "MG Road", owner_name: "Ganesh" },
      rooms: { room_number: "202" },
    };
    const expected = buildReceipt(payment, {
      tenantName: "Ravi Kumar",
      propertyName: "Sunrise PG",
      propertyAddress: "MG Road",
      ownerName: "Ganesh",
      roomNumber: "202",
    });

    const onDownload = vi.fn();
    const view = renderNode(
      <RentReceipt payment={payment} tenantName="Ravi Kumar" onDownloadPdf={onDownload} />,
    );

    const triggerBtn = view.container.querySelector("button")!;
    expect(triggerBtn.textContent).toContain("Receipt");

    await act(async () => {
      triggerBtn.click();
    });

    const dialogText = document.body.textContent || "";
    expect(dialogText).toContain(expected.receiptNo);
    expect(dialogText).toContain(expected.title);
    expect(dialogText).toContain(expected.totalText);
    expect(dialogText).toContain(expected.totalInWords);
    expect(dialogText).toContain(expected.issuedOn);
    expect(dialogText).toContain("Security deposit");

    const dlBtn = Array.from(document.body.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Download PDF"),
    );
    expect(dlBtn).toBeDefined();
    await act(async () => {
      dlBtn!.click();
    });
    expect(onDownload).toHaveBeenCalledTimes(1);

    view.cleanup();
  });

  it("Payments.tsx Paid tab & Record Payment send only { payment_id } via send-payment-receipt and toast outcome", async () => {
    invokeMock.mockResolvedValue({ data: { sent: 1, via: "document" }, error: null });

    const view = renderNode(<Payments />);
    await flushUi();

    const paidTab = Array.from(view.container.querySelectorAll('[role="tab"]')).find((el) =>
      el.textContent?.includes("Paid"),
    ) as HTMLElement | undefined;
    expect(paidTab).toBeDefined();

    await act(async () => {
      paidTab!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      paidTab!.click();
    });
    await flushUi();

    const sendBtn = Array.from(view.container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Send receipt on WhatsApp"),
    );
    expect(sendBtn).toBeDefined();

    await act(async () => {
      sendBtn!.click();
    });
    await flushUi();

    expect(invokeMock).toHaveBeenCalledWith("twilio-notifications", {
      body: {
        action: "send-payment-receipt",
        payment_id: "abcdef12-3456-7890-abcd-ef1234567890",
      },
    });
    expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ title: "PDF sent" }));
    view.cleanup();

    // Pending payment -> Record Payment -> automatic send-payment-receipt with { payment_id } only
    invokeMock.mockReset();
    toastMock.mockReset();
    invokeMock.mockResolvedValue({ data: { sent: 1, via: "link", reason: "WA offline" }, error: null });
    rentPaymentsData.current = [
      {
        id: "11111111-2222-3333-4444-555555555555",
        tenant_id: "tenant-1",
        tenant_email: "ravi@example.com",
        tenant_name: "Ravi Kumar",
        tenant_phone: "9876543210",
        property_id: "prop-1",
        room_id: "room-1",
        amount: 9000,
        month: "2026-11",
        status: "pending",
        payment_type: "rent",
        payment_date: null,
        proof_url: null,
        proof_uploaded_at: null,
        rooms: { room_number: "101" },
        properties: { name: "Sunrise PG", address: "MG Road" },
      },
    ];

    const pendingView = renderNode(<Payments />);
    await flushUi();

    const recordBtn = Array.from(pendingView.container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Record Payment"),
    );
    expect(recordBtn).toBeDefined();

    await act(async () => {
      recordBtn!.click();
    });
    await flushUi();

    const confirmBtn = Array.from(document.body.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Confirm Payment"),
    );
    expect(confirmBtn).toBeDefined();

    await act(async () => {
      confirmBtn!.click();
    });
    await flushUi();

    expect(invokeMock).toHaveBeenCalledWith("twilio-notifications", {
      body: {
        action: "send-payment-receipt",
        payment_id: "11111111-2222-3333-4444-555555555555",
      },
    });
    expect(toastMock).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Link sent (WhatsApp server offline)" }),
    );
    pendingView.cleanup();
  });

  it("TenantPayments.tsx downloads PDF Blob on web and sends to tenant WhatsApp on native Capacitor", async () => {
    const createUrlOrig = window.URL.createObjectURL;
    const revokeUrlOrig = window.URL.revokeObjectURL;
    const anchorClickOrig = HTMLAnchorElement.prototype.click;
    const clickedDownloads: string[] = [];
    const createUrlMock = vi.fn(() => "blob:pgbuddy-test");
    const revokeUrlMock = vi.fn();
    window.URL.createObjectURL = createUrlMock;
    window.URL.revokeObjectURL = revokeUrlMock;
    HTMLAnchorElement.prototype.click = function clickStub() {
      clickedDownloads.push(this.getAttribute("download") || "");
    };

    try {
      const pdfBlob = new Blob(["%PDF-1.7\n"], { type: "application/pdf" });
      invokeMock.mockResolvedValueOnce({ data: pdfBlob, error: null });

      const webView = renderNode(<TenantPayments />);
      await flushUi();

      const dlBtn = Array.from(webView.container.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("Download receipt PDF"),
      );
      expect(dlBtn).toBeDefined();

      await act(async () => {
        dlBtn!.click();
      });
      await flushUi();

      expect(invokeMock).toHaveBeenCalledWith("twilio-notifications", {
        body: {
          action: "send-payment-receipt",
          payment_id: "abcdef12-3456-7890-abcd-ef1234567890",
          mode: "download",
        },
      });
      expect(createUrlMock).toHaveBeenCalledWith(pdfBlob);
      expect(clickedDownloads).toEqual(["PGB-ABCDEF12-Nov-2026.pdf"]);
      expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ title: "Receipt PDF downloaded" }));
      webView.cleanup();

      // Native Capacitor APK branch: switches action to Send to my WhatsApp (mode: "send")
      isNativeMock.mockReturnValue(true);
      invokeMock.mockResolvedValueOnce({ data: { sent: 1, via: "link", reason: "WA offline" }, error: null });

      const nativeView = renderNode(<TenantPayments />);
      await flushUi();

      const waBtn = Array.from(nativeView.container.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("Send to my WhatsApp"),
      );
      expect(waBtn).toBeDefined();

      await act(async () => {
        waBtn!.click();
      });
      await flushUi();

      expect(invokeMock).toHaveBeenCalledWith("twilio-notifications", {
        body: {
          action: "send-payment-receipt",
          payment_id: "abcdef12-3456-7890-abcd-ef1234567890",
          mode: "send",
        },
      });
      expect(toastMock).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Link sent (WhatsApp server offline)" }),
      );
      nativeView.cleanup();
    } finally {
      window.URL.createObjectURL = createUrlOrig;
      window.URL.revokeObjectURL = revokeUrlOrig;
      HTMLAnchorElement.prototype.click = anchorClickOrig;
    }
  });
});
