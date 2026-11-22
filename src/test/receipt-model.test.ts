import { describe, expect, it } from "vitest";
import { amountInWords, buildReceipt, formatIndiaDate, formatIndianNumber, receiptNumber } from "@/lib/receipt";

const now = new Date("2026-11-22T06:00:00Z");

describe("receipt model", () => {
  it("numbers receipts from the payment id", () => {
    expect(receiptNumber("3f2a9c1e-0000-4000-8000-000000000000")).toBe("PGB-3F2A9C1E");
  });

  it("formats money the Indian way, in words and digits", () => {
    expect(formatIndianNumber(1234567.5)).toBe("12,34,567.50");
    expect(formatIndianNumber(500)).toBe("500.00");
    expect(amountInWords(12500)).toBe("Rupees Twelve Thousand Five Hundred Only");
    expect(amountInWords(105000.5)).toBe("Rupees One Lakh Five Thousand and Fifty Paise Only");
    expect(amountInWords(0)).toBe("Rupees Zero Only");
    expect(amountInWords(12345678)).toBe("Rupees One Crore Twenty Three Lakh Forty Five Thousand Six Hundred Seventy Eight Only");
  });

  it("dates receipts in India time: 20:00 UTC is already the next day in India", () => {
    expect(formatIndiaDate("2026-11-21T20:00:00Z")).toBe("22 Nov 2026");
    expect(formatIndiaDate(null, now)).toBe("22 Nov 2026");
    expect(formatIndiaDate("not a date", now)).toBe("22 Nov 2026");
  });

  it("builds a rent receipt", () => {
    const r = buildReceipt(
      { id: "abcdef12-3456", amount: "8500", month: "November 2026", payment_date: "2026-11-05T10:00:00Z", status: "paid", payment_method: "upi", transaction_id: "UTR123" },
      { tenantName: "  Ravi   Kumar ", propertyName: "Sunrise PG", roomNumber: "204" },
      now,
    );
    expect(r).toMatchObject({
      receiptNo: "PGB-ABCDEF12",
      title: "Rent Payment Receipt",
      kind: "rent",
      issuedOn: "05 Nov 2026",
      isPaid: true,
      total: 8500,
      totalText: "Rs. 8,500.00",
      tenantName: "Ravi Kumar",
      roomNumber: "204",
      method: "UPI",
      transactionId: "UTR123",
      fileName: "PGB-ABCDEF12-November-2026.pdf",
    });
    expect(r.lines).toEqual([{ label: "Monthly rent - November 2026", amount: 8500 }]);
  });

  it("builds a deposit receipt and handles legacy rows with no payment date", () => {
    const r = buildReceipt({ id: "11112222", amount: 20000, payment_type: "deposit", status: "paid", created_at: "2026-03-01T00:00:00Z" }, {}, now);
    expect(r.title).toBe("Security Deposit Receipt");
    expect(r.lines[0].label).toBe("Security deposit");
    expect(r.issuedOn).toBe("01 Mar 2026");
    expect(r.fileName).toBe("PGB-11112222-Deposit.pdf");
    expect(r.tenantName).toBe("Tenant");
  });

  it("never calls an unpaid payment paid, and survives a bad amount", () => {
    const r = buildReceipt({ id: "x", amount: "abc", status: "pending" }, {}, now);
    expect(r.isPaid).toBe(false);
    expect(r.statusLabel).toBe("Pending");
    expect(r.total).toBe(0);
  });

  it("keeps file names safe for WhatsApp", () => {
    const r = buildReceipt({ id: "abcd1234", amount: 1, month: "Nov/Dec 2026 <x>", status: "paid" }, {}, now);
    expect(r.fileName).toMatch(/^[\w\-. ]{1,80}\.pdf$/);
  });
});
