// One receipt model for every place a receipt is shown or sent: the PDF the edge function renders for
// WhatsApp, the on-screen RentReceipt, and the public receipt page. Pure TypeScript with no imports, so
// Deno (edge functions) and Vite (the app) both load it, and vitest tests it directly.

export type ReceiptPaymentInput = {
  id: string;
  amount: number | string;
  month?: string | null;
  payment_date?: string | null;
  created_at?: string | null;
  status?: string | null;
  payment_type?: string | null;
  payment_method?: string | null;
  transaction_id?: string | null;
};

export type ReceiptPartyInput = {
  tenantName?: string | null;
  tenantPhone?: string | null;
  propertyName?: string | null;
  propertyAddress?: string | null;
  ownerName?: string | null;
  ownerPhone?: string | null;
  roomNumber?: string | null;
};

export type ReceiptLine = { label: string; amount: number };

export type ReceiptModel = {
  receiptNo: string;
  title: string;
  kind: "rent" | "deposit" | "other";
  /** dd MMM yyyy, in India time. */
  issuedOn: string;
  /** "Paid" or "Pending": the PDF is only offered for paid payments, but the model never lies. */
  statusLabel: string;
  isPaid: boolean;
  lines: ReceiptLine[];
  total: number;
  /** "Rs. 12,500.00", safe for PDF standard fonts that have no rupee sign. */
  totalText: string;
  totalInWords: string;
  tenantName: string;
  propertyName: string;
  propertyAddress: string;
  ownerName: string;
  roomNumber: string;
  method: string;
  transactionId: string;
  /** Safe for a WhatsApp document name: letters, digits, dash, dot. */
  fileName: string;
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Receipt number shown to people: stable for a payment, short enough to read out on a call. */
export function receiptNumber(paymentId: string): string {
  const hex = paymentId.replace(/[^0-9a-f]/gi, "").slice(0, 8).toUpperCase();
  return `PGB-${hex || "00000000"}`;
}

/** dd MMM yyyy in Asia/Kolkata (UTC+5:30, no DST), without Intl so Deno and old WebViews agree. */
export function formatIndiaDate(iso: string | null | undefined, fallback: Date = new Date()): string {
  const parsed = iso ? new Date(iso) : fallback;
  const d = Number.isNaN(parsed.getTime()) ? fallback : parsed;
  const ist = new Date(d.getTime() + 330 * 60 * 1000);
  const day = String(ist.getUTCDate()).padStart(2, "0");
  return `${day} ${MONTHS[ist.getUTCMonth()]} ${ist.getUTCFullYear()}`;
}

/** 1234567.5 -> "12,34,567.50" (Indian digit grouping). */
export function formatIndianNumber(value: number): string {
  const negative = value < 0;
  const [intPart, frac] = Math.abs(value).toFixed(2).split(".");
  const last3 = intPart.slice(-3);
  const rest = intPart.slice(0, -3);
  const grouped = rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${last3}` : last3;
  return `${negative ? "-" : ""}${grouped}.${frac}`;
}

const ONES = [
  "", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve",
  "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen",
];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

function belowHundred(n: number): string {
  if (n < 20) return ONES[n];
  return `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${ONES[n % 10]}` : ""}`;
}

function belowThousand(n: number): string {
  const h = Math.floor(n / 100);
  const r = n % 100;
  return [h ? `${ONES[h]} Hundred` : "", r ? belowHundred(r) : ""].filter(Boolean).join(" ");
}

/** 12500.5 -> "Rupees Twelve Thousand Five Hundred and Fifty Paise Only" (Indian scale: lakh, crore). */
export function amountInWords(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "";
  const totalPaise = Math.round(value * 100);
  let rupees = Math.floor(totalPaise / 100);
  const paise = totalPaise % 100;
  if (rupees === 0 && paise === 0) return "Rupees Zero Only";

  const parts: string[] = [];
  const crore = Math.floor(rupees / 10000000);
  rupees %= 10000000;
  const lakh = Math.floor(rupees / 100000);
  rupees %= 100000;
  const thousand = Math.floor(rupees / 1000);
  rupees %= 1000;
  if (crore) parts.push(`${crore >= 100 ? belowThousand(crore) : belowHundred(crore)} Crore`);
  if (lakh) parts.push(`${belowHundred(lakh)} Lakh`);
  if (thousand) parts.push(`${belowHundred(thousand)} Thousand`);
  if (rupees) parts.push(belowThousand(rupees));

  const rupeeText = parts.length ? `Rupees ${parts.join(" ")}` : "";
  const paiseText = paise ? `${belowHundred(paise)} Paise` : "";
  return `${[rupeeText, paiseText].filter(Boolean).join(" and ")} Only`;
}

function clean(value: string | null | undefined, fallback: string): string {
  const v = (value ?? "").replace(/\s+/g, " ").trim();
  return v || fallback;
}

const METHOD_LABELS: Record<string, string> = {
  upi: "UPI",
  cash: "Cash",
  bank_transfer: "Bank transfer",
  card: "Card",
  razorpay: "Online (Razorpay)",
  cheque: "Cheque",
};

export function buildReceipt(payment: ReceiptPaymentInput, party: ReceiptPartyInput = {}, now: Date = new Date()): ReceiptModel {
  const amount = Number(payment.amount);
  const total = Number.isFinite(amount) ? Math.round(amount * 100) / 100 : 0;
  const type = (payment.payment_type ?? "rent").toLowerCase();
  const kind: ReceiptModel["kind"] = type === "deposit" ? "deposit" : type === "rent" || !type ? "rent" : "other";
  const month = clean(payment.month, "");
  const isPaid = (payment.status ?? "").toLowerCase() === "paid";

  const label =
    kind === "deposit" ? "Security deposit"
    : kind === "rent" ? (month ? `Monthly rent - ${month}` : "Monthly rent")
    : `${clean(payment.payment_type, "Payment").replace(/_/g, " ")}${month ? ` - ${month}` : ""}`;

  const receiptNo = receiptNumber(payment.id);
  const methodKey = (payment.payment_method ?? "").toLowerCase();
  const fileMonth = (kind === "deposit" ? "Deposit" : month || "Receipt").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "");

  return {
    receiptNo,
    title: kind === "deposit" ? "Security Deposit Receipt" : "Rent Payment Receipt",
    kind,
    // Legacy paid rows have no payment_date: fall back to when the row was created, then to today.
    issuedOn: formatIndiaDate(payment.payment_date ?? payment.created_at, now),
    statusLabel: isPaid ? "Paid" : "Pending",
    isPaid,
    lines: [{ label, amount: total }],
    total,
    totalText: `Rs. ${formatIndianNumber(total)}`,
    totalInWords: amountInWords(total),
    tenantName: clean(party.tenantName, "Tenant"),
    propertyName: clean(party.propertyName, "PG"),
    propertyAddress: clean(party.propertyAddress, ""),
    ownerName: clean(party.ownerName, ""),
    roomNumber: clean(party.roomNumber, "-"),
    method: METHOD_LABELS[methodKey] ?? clean(payment.payment_method, "-"),
    transactionId: clean(payment.transaction_id, "-"),
    fileName: `${receiptNo}-${fileMonth || "Receipt"}.pdf`,
  };
}
