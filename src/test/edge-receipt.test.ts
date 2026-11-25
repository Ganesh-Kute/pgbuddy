// send-payment-receipt (twilio-notifications) and the receipt PDF renderer.
import { describe, expect, it } from "vitest";
import * as pdfLib from "pdf-lib";
import { buildReceipt } from "../../supabase/functions/_shared/receipt-model.ts";
import { clampLines, ellipsize, pdfText, renderReceiptPdf, wrapText } from "../../supabase/functions/_shared/receipt-pdf.ts";
import { inflateSync } from "node:zlib";
import { bytesToBase64, RECEIPT_SEND_LOG } from "../../supabase/functions/twilio-notifications/receipt.ts";
import { createTwilioNotificationsHandler } from "../../supabase/functions/twilio-notifications/handler.ts";
import { placeholderCount, TEMPLATES } from "../../supabase/functions/_shared/whatsapp-templates.ts";

const OWNER = "00000000-0000-4000-8000-000000000001";
const TENANT_A = "00000000-0000-4000-8000-00000000000a";
const TENANT_B = "00000000-0000-4000-8000-00000000000b";
const STAFF = "00000000-0000-4000-8000-000000000005";
const OTHER_STAFF = "00000000-0000-4000-8000-000000000006";
const STRANGER = "00000000-0000-4000-8000-000000000009";
const PAID = "11111111-1111-4111-8111-111111111111";
const PENDING = "22222222-2222-4222-8222-222222222222";
const PAID_B = "33333333-3333-4333-8333-333333333333";

const decode = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const head = (bytes: Uint8Array) => String.fromCharCode(...bytes.slice(0, 5));

// The standard fonts encode text as WinAnsi (Windows-1252): "…" is the single byte 0x85.
// WinAnsi (windows-1252) by hand: Node 20's TextDecoder("windows-1252") decodes 0x80-0x9F as Latin-1
// control characters, so "…" (0x85) came back as U+0085 on CI and the ellipsis checks failed there only.
const WIN_ANSI_HIGH: Record<number, string> = {
  0x80: "€", 0x82: "‚", 0x83: "ƒ", 0x84: "„", 0x85: "…", 0x86: "†", 0x87: "‡", 0x88: "ˆ", 0x89: "‰", 0x8a: "Š",
  0x8b: "‹", 0x8c: "Œ", 0x8e: "Ž", 0x91: "‘", 0x92: "’", 0x93: "“", 0x94: "”", 0x95: "•", 0x96: "–", 0x97: "—",
  0x98: "˜", 0x99: "™", 0x9a: "š", 0x9b: "›", 0x9c: "œ", 0x9e: "ž", 0x9f: "Ÿ",
};
const winAnsi = {
  decode: (bytes: Uint8Array) => Array.from(bytes, (b) => WIN_ANSI_HIGH[b] ?? String.fromCharCode(b)).join(""),
};

/** Every string drawn on the page: inflate the content streams and decode pdf-lib's <hex> text operands. */
function drawnText(bytes: Uint8Array): string[] {
  const raw = Buffer.from(bytes);
  const out: string[] = [];
  let at = 0;
  for (;;) {
    const start = raw.indexOf("stream", at);
    if (start < 0) break;
    const dataStart = start + (raw[start + 6] === 0x0d ? 8 : 7);
    const end = raw.indexOf("endstream", dataStart);
    try {
      const text = inflateSync(raw.subarray(dataStart, end)).toString("latin1");
      for (const m of text.matchAll(/<([0-9A-Fa-f]+)> Tj/g)) out.push(winAnsi.decode(Buffer.from(m[1], "hex")));
    } catch {
      // Not a deflated stream.
    }
    at = end + 9;
  }
  return out;
}

describe("receipt PDF", () => {
  const payment = { id: PAID, amount: 8500, month: "2026-11", payment_date: "2026-11-05T06:00:00Z", status: "paid", payment_method: "upi", transaction_id: "T123" };

  it("renders a small, valid PDF", async () => {
    const bytes = await renderReceiptPdf(pdfLib, buildReceipt(payment, { tenantName: "Ravi Kumar", propertyName: "Sunrise PG", roomNumber: "104" }));
    expect(head(bytes)).toBe("%PDF-");
    expect(bytes.length).toBeLessThan(10 * 1024);
    const loaded = await pdfLib.PDFDocument.load(bytes);
    expect(loaded.getPageCount()).toBe(1);
    expect(loaded.getTitle()).toContain("PGB-11111111");
  });

  it("brands the receipt with the PG and keeps PG Buddy to the footer", async () => {
    const receipt = buildReceipt(payment, {
      tenantName: "Ravi Kumar",
      propertyName: "Sunrise PG",
      propertyAddress: "12, MG Road, Pune",
      ownerName: "Sunil Patil",
      ownerPhone: "+91 98765 43210",
      roomNumber: "104",
    });
    const text = drawnText(await renderReceiptPdf(pdfLib, receipt));
    expect(text[0]).toBe("PAYMENT RECEIPT");
    expect(text).toEqual(expect.arrayContaining([
      "Sunrise PG", "12, MG Road, Pune", "Phone: +91 98765 43210", "PGB-11111111", "Date: 05 Nov 2026",
      "Ravi Kumar", "Room 104", "UPI", "Txn ID: T123", "Nov 2026", "PAID",
      "Monthly rent - Nov 2026", "Rs. 8,500.00", "Rupees Eight Thousand Five Hundred Only",
      "Received by Sunil Patil", "Powered by ", "PG Buddy",
    ]));
    // PG Buddy appears only in the footer line, never as the heading.
    expect(text.filter((t) => t.includes("PG Buddy"))).toEqual(["PG Buddy"]);
  });

  it("labels a deposit receipt as one", async () => {
    const receipt = buildReceipt({ ...payment, payment_type: "deposit", month: null }, { propertyName: "Green Leaf", ownerName: "" });
    const text = drawnText(await renderReceiptPdf(pdfLib, receipt));
    expect(text).toEqual(expect.arrayContaining(["SECURITY DEPOSIT RECEIPT", "DEPOSIT RECEIVED", "Security deposit", "Green Leaf management"]));
  });

  it("clamps long names and addresses to two lines and stays fast", async () => {
    const long = buildReceipt(
      { ...payment, amount: 1234567.5, transaction_id: "NEFT-HDFC-0000123456789-REF-ABCDEFGHIJ" },
      {
        tenantName: "Venkata Subramanian Lakshminarayanan Ramachandran Iyer",
        propertyName: "Shree Sai Krupa Executive Paying Guest Accommodation for Working Professionals",
        propertyAddress: "Plot No. 42, Survey No. 118/2B, Behind Old Hanuman Temple, Near Municipal Bus Depot, Karve Nagar, Kothrud, Pune 411052",
        roomNumber: "Wing C, Floor 3, Room 312 (Window bed)",
      },
    );
    const bytes = await renderReceiptPdf(pdfLib, long);
    expect(bytes.length).toBeLessThan(10 * 1024);
    const text = drawnText(bytes);
    expect(text.filter((t) => t.endsWith("…")).length).toBeGreaterThanOrEqual(3);
    expect(text.some((t) => t.startsWith("Txn ID: NEFT-HDFC"))).toBe(true);
    const start = performance.now();
    for (let i = 0; i < 20; i++) await renderReceiptPdf(pdfLib, long);
    expect((performance.now() - start) / 20).toBeLessThan(50);
  });

  it("does not throw on Devanagari names, emoji or the rupee sign", async () => {
    const receipt = buildReceipt(payment, {
      tenantName: "रवि कुमार",
      propertyName: "श्री PG",
      propertyAddress: "Flat 2, “Shanti” Nagar — Pune 🏠",
      ownerName: "सुनील",
    });
    receipt.lines[0].label = "Rent ₹8500 🏠";
    const bytes = await renderReceiptPdf(pdfLib, receipt);
    expect(head(bytes)).toBe("%PDF-");
  });

  it("keeps only what the standard fonts can draw, with a fallback for names in other scripts", () => {
    expect(pdfText("₹500")).toBe("Rs.500");
    expect(pdfText("रवि कुमार", "Tenant")).toBe("Tenant");
    expect(pdfText("श्री PG", "PG")).toBe("PG");
    expect(pdfText("“Shanti”\tNagar — Pune 🏠")).toBe("“Shanti” Nagar — Pune");
    expect(pdfText("José Müller")).toBe("José Müller");
  });

  it("ellipsizes and clamps to the width", async () => {
    const doc = await pdfLib.PDFDocument.create();
    const font = await doc.embedFont(pdfLib.StandardFonts.Helvetica);
    expect(ellipsize("short", font, 10, 200)).toBe("short");
    const cut = ellipsize("Txn ID: NEFT-HDFC-0000123456789-REF-ABCDEFGHIJ", font, 10, 120);
    expect(cut.startsWith("Txn ID: NEFT")).toBe(true);
    expect(cut.endsWith("…")).toBe(true);
    expect(font.widthOfTextAtSize(cut, 10)).toBeLessThanOrEqual(120);
    const lines = clampLines("one two three four five six seven eight nine ten eleven twelve", font, 10, 60, 2);
    expect(lines).toHaveLength(2);
    expect(lines[1].endsWith("…")).toBe(true);
    for (const l of lines) expect(font.widthOfTextAtSize(l, 10)).toBeLessThanOrEqual(60);
  });

  it("wraps long text to the line width", async () => {
    const doc = await pdfLib.PDFDocument.create();
    const font = await doc.embedFont(pdfLib.StandardFonts.Helvetica);
    const lines = wrapText("Plot 42, Behind the big temple, Near the old bus stand, Kothrud, Pune 411038", font, 10, 120);
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines) expect(font.widthOfTextAtSize(l, 10)).toBeLessThanOrEqual(120);
  });
});

// ---- an in-memory Supabase for the handler ----
type Row = Record<string, unknown>;

function makeDb(nowMs: () => number) {
  const tables: Record<string, Row[]> = {
    rent_payments: [
      { id: PAID, amount: 8500, month: "2026-11", payment_date: "2026-11-05T06:00:00Z", created_at: "2026-11-01T00:00:00Z", status: "paid", payment_type: "rent", payment_method: "upi", transaction_id: "T123", tenant_id: TENANT_A, tenant_name: "Ravi", tenant_phone: "+91 98765 00000", property_id: "prop-1", room_id: "room-1" },
      { id: PENDING, amount: 8500, month: "2026-12", status: "pending", tenant_id: TENANT_A, tenant_phone: "9876500000", property_id: "prop-1", room_id: "room-1" },
      { id: PAID_B, amount: 9000, month: "2026-11", status: "paid", tenant_id: TENANT_B, tenant_phone: "9123400000", property_id: "prop-1", room_id: "room-2" },
    ],
    properties: [
      { id: "prop-1", name: "Sunrise PG", address: "MG Road, Pune", owner_id: OWNER },
      { id: "prop-2", name: "Other PG", address: "", owner_id: OWNER },
    ],
    rooms: [{ id: "room-1", room_number: "104" }, { id: "room-2", room_number: "105" }],
    profiles: [
      { user_id: OWNER, full_name: "Sunil Owner", phone: "9000000001" },
      { user_id: TENANT_A, full_name: "Ravi Kumar", phone: "9876511111" },
    ],
    // The assignment phone is the one the receipt goes to.
    tenant_assignments: [
      { tenant_id: TENANT_A, tenant_name: "Ravi Kumar", tenant_phone: "9876543210", property_id: "prop-1", room_id: "room-1", is_active: true },
      { tenant_id: TENANT_B, tenant_name: "Bina", tenant_phone: "9123456789", property_id: "prop-1", room_id: "room-2", is_active: true },
    ],
    staff_members: [
      { id: "s1", owner_id: OWNER, staff_user_id: STAFF, property_id: "prop-1", status: "active" },
      { id: "s2", owner_id: OWNER, staff_user_id: OTHER_STAFF, property_id: "prop-2", status: "active" },
    ],
    user_roles: [{ user_id: STRANGER, role: "owner" }],
    mess_members: [{ owner_id: OWNER, phone: "9555500000" }],
    audit_logs: [],
  };

  function from(table: string) {
    const rows = () => tables[table] ?? [];
    const select = () => {
      const tests: Array<(r: Row) => boolean> = [];
      let order: { col: string; asc: boolean } | null = null;
      let max = Infinity;
      const run = () => {
        let out = rows().filter((r) => tests.every((t) => t(r)));
        if (order) {
          const { col, asc } = order;
          out = [...out].sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : 1) * (asc ? 1 : -1));
        }
        return out.slice(0, max);
      };
      const chain = {
        eq(col: string, val: unknown) { tests.push((r) => r[col] === val); return chain; },
        in(col: string, vals: unknown[]) { tests.push((r) => vals.includes(r[col])); return chain; },
        gte(col: string, val: unknown) { tests.push((r) => String(r[col]) >= String(val)); return chain; },
        or() { return chain; },
        order(col: string, o: { ascending: boolean }) { order = { col, asc: o.ascending }; return chain; },
        limit(n: number) { max = n; return chain; },
        async maybeSingle() { return { data: run()[0] ?? null, error: null }; },
        async single() { return { data: run()[0] ?? null, error: null }; },
        then<T1 = { data: Row[]; error: null }, T2 = never>(
          ok?: ((v: { data: Row[]; error: null }) => T1 | PromiseLike<T1>) | null,
          bad?: ((e: unknown) => T2 | PromiseLike<T2>) | null,
        ) {
          return Promise.resolve({ data: run(), error: null }).then(ok, bad);
        },
      };
      return chain;
    };
    return {
      select,
      async insert(row: Row) {
        (tables[table] ??= []).push({ created_at: new Date(nowMs()).toISOString(), ...row });
        return { error: null };
      },
    };
  }
  return { tables, from };
}

type Call = { url: string; body: Record<string, unknown> };

type CloudReply = { status: number; body: unknown };

function setup(opts: { docStatus?: number; docBody?: string; cloud?: { media?: CloudReply; messages?: CloudReply } } = {}) {
  let now = Date.parse("2026-11-22T10:00:00Z");
  const db = makeDb(() => now);
  const calls: Call[] = [];
  const handler = createTwilioNotificationsHandler({
    pdfLib,
    nowFn: () => new Date(now),
    createClient: ((_url: string, key: string, options?: { global: { headers: { Authorization: string } } }) => ({
      auth: {
        async getUser() {
          const id = options?.global.headers.Authorization.replace("Bearer ", "") ?? "";
          return key === "anon-jwt-key" && id ? { data: { user: { id } }, error: null } : { data: { user: null }, error: { message: "bad" } };
        },
      },
      from: db.from,
    })) as never,
    fetchFn: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const raw = init?.body;
      let body: Record<string, unknown> = {};
      if (raw instanceof FormData) body = Object.fromEntries([...raw.entries()].map(([k, v]) => [k, typeof v === "string" ? v : `<file ${(v as File).name}>`]));
      else body = JSON.parse(String(raw ?? "{}"));
      calls.push({ url, body });
      if (url.startsWith("https://graph.facebook.com/")) {
        const reply = url.endsWith("/media") ? opts.cloud?.media : opts.cloud?.messages;
        return new Response(JSON.stringify(reply?.body ?? {}), { status: reply?.status ?? 200 });
      }
      if (url.endsWith("/api/send-document")) {
        return new Response(opts.docBody ?? JSON.stringify({ sent: true }), { status: opts.docStatus ?? 200 });
      }
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }) as typeof fetch,
    getEnv: (name: string) => ({
      SUPABASE_URL: "https://vcpohetbsyyjqqkzuzxj.supabase.co",
      SUPABASE_ANON_KEY: "anon-jwt-key",
      SUPABASE_SERVICE_ROLE_KEY: "service-role-secret-key",
      CRON_SECRET: "cron-secret-123456",
      WA_SERVER_URL: "https://wa.pgbuddy.example",
      WA_SERVER_SECRET: "super-strong-wa-secret-999",
      ...(opts.cloud ? { WHATSAPP_TOKEN: "EAA-test-token", WHATSAPP_PHONE_NUMBER_ID: "1553178531205507" } : {}),
    } as Record<string, string>)[name],
  });
  const call = (user: string | null, body: Record<string, unknown>) =>
    handler(new Request("https://fn.test", {
      method: "POST",
      headers: user ? { Authorization: `Bearer ${user}` } : {},
      body: JSON.stringify(body),
    }));
  return { db, calls, call, advance: (ms: number) => { now += ms; } };
}

const receiptBody = (payment_id: string, extra: Record<string, unknown> = {}) => ({ action: "send-payment-receipt", payment_id, ...extra });

describe("send-payment-receipt", () => {
  it("sends the PDF to the tenant's phone from the database, ignoring any phone in the request", async () => {
    const t = setup();
    const resp = await t.call(OWNER, receiptBody(PAID, { tenant_phone: "9999999999", amount: 1 }));
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ sent: true, via: "document", receipt_no: "PGB-11111111" });

    expect(t.calls).toHaveLength(1);
    const { url, body } = t.calls[0];
    expect(url).toBe("https://wa.pgbuddy.example/api/send-document");
    expect(body.phoneNumber).toBe("919876543210");
    expect(body.mimetype).toBe("application/pdf");
    expect(body.filename).toMatch(/^[\w\- .]{1,80}\.pdf$/);
    const pdf = decode(String(body.base64));
    expect(head(pdf)).toBe("%PDF-");
    expect(pdf.length).toBeLessThan(200 * 1024);
    expect(String(body.caption)).toContain("Rs. 8,500.00");

    const log = t.db.tables.audit_logs[0];
    expect(log).toMatchObject({ table_name: RECEIPT_SEND_LOG, record_id: PAID, action: "INSERT", user_id: OWNER, property_id: "prop-1" });
  });

  it("limits sends per payment: once a minute, three an hour", async () => {
    const t = setup();
    expect((await t.call(OWNER, receiptBody(PAID))).status).toBe(200);
    const soon = await t.call(OWNER, receiptBody(PAID));
    expect(soon.status).toBe(429);
    expect(await soon.json()).toMatchObject({ sent: false, reason: "cooldown" });
    expect(Number(soon.headers.get("Retry-After"))).toBeGreaterThan(0);

    t.advance(61_000);
    expect((await t.call(TENANT_A, receiptBody(PAID))).status).toBe(200);
    t.advance(61_000);
    expect((await t.call(OWNER, receiptBody(PAID))).status).toBe(200);
    t.advance(61_000);
    expect((await t.call(OWNER, receiptBody(PAID))).status).toBe(429);
    // Other payments have their own allowance.
    expect((await t.call(OWNER, receiptBody(PAID_B))).status).toBe(200);
  });

  it("lets a tenant send their own receipt, and only their own", async () => {
    const t = setup();
    expect((await t.call(TENANT_A, receiptBody(PAID))).status).toBe(200);
    const other = await t.call(TENANT_B, receiptBody(PAID));
    expect(other.status).toBe(403);
    const download = await t.call(TENANT_B, receiptBody(PAID, { mode: "download" }));
    expect(download.status).toBe(403);
  });

  it("allows staff of the property, not staff of another property or other owners", async () => {
    const t = setup();
    expect((await t.call(STAFF, receiptBody(PAID))).status).toBe(200);
    expect((await t.call(OTHER_STAFF, receiptBody(PAID_B))).status).toBe(403);
    expect((await t.call(STRANGER, receiptBody(PAID_B))).status).toBe(403);
    expect((await t.call(null, receiptBody(PAID))).status).toBe(401);
  });

  it("only issues receipts for paid payments, and rejects bad input", async () => {
    const t = setup();
    const pending = await t.call(OWNER, receiptBody(PENDING));
    expect(pending.status).toBe(409);
    expect(await pending.json()).toMatchObject({ reason: "not_paid" });
    // A stranger learns nothing about the payment's status.
    expect((await t.call(STRANGER, receiptBody(PENDING))).status).toBe(403);
    expect((await t.call(OWNER, receiptBody("44444444-4444-4444-8444-444444444444"))).status).toBe(404);
    expect((await t.call(OWNER, receiptBody("not-a-uuid"))).status).toBe(400);
    expect((await t.call(OWNER, receiptBody(PAID, { mode: "fax" }))).status).toBe(400);
    expect(t.calls).toHaveLength(0);
  });

  it("returns the PDF itself in download mode", async () => {
    const t = setup();
    const resp = await t.call(TENANT_A, receiptBody(PAID, { mode: "download" }));
    expect(resp.status).toBe(200);
    expect(resp.headers.get("Content-Type")).toBe("application/pdf");
    expect(resp.headers.get("Content-Disposition")).toBe('attachment; filename="PGB-11111111-Nov-2026.pdf"');
    expect(head(new Uint8Array(await resp.arrayBuffer()))).toBe("%PDF-");
    expect(t.calls).toHaveLength(0);
    expect(t.db.tables.audit_logs).toHaveLength(0);
  });

  it("falls back to the link when the WA server has no document endpoint", async () => {
    const t = setup({ docStatus: 404, docBody: "<!DOCTYPE html><pre>Cannot POST /api/send-document</pre>" });
    const resp = await t.call(OWNER, receiptBody(PAID));
    expect(await resp.json()).toMatchObject({ sent: true, via: "link" });
    expect(t.calls.map((c) => c.url)).toEqual(["https://wa.pgbuddy.example/api/send-document", "https://wa.pgbuddy.example/api/send-instant"]);
    expect(String(t.calls[1].body.message)).toContain("https://pgbuddy-zeta-rust.vercel.app/receipt/" + PAID);
    expect(t.calls[1].body.phoneNumber).toBe("919876543210");
  });

  it("reports a number that is not on WhatsApp instead of sending a link", async () => {
    const t = setup({ docStatus: 404, docBody: JSON.stringify({ error: "not_on_whatsapp" }) });
    const resp = await t.call(OWNER, receiptBody(PAID));
    expect(await resp.json()).toEqual({ sent: false, via: null, reason: "not_on_whatsapp" });
    expect(t.calls).toHaveLength(1);
    expect(t.db.tables.audit_logs).toHaveLength(0);
  });
});

describe("older actions only message the caller's own tenants", () => {
  it("send-payment-received: blocks a number that is not a tenant of the property", async () => {
    const t = setup();
    const spoof = await t.call(OWNER, { action: "send-payment-received", property_id: "prop-1", tenant_phone: "9999999999", amount: 1 });
    expect(spoof.status).toBe(403);
    const real = await t.call(OWNER, { action: "send-payment-received", property_id: "prop-1", tenant_phone: "+91 98765 43210", amount: 8500 });
    expect(real.status).toBe(200);
    // A self-made "owner" with no properties cannot reach anyone.
    const stranger = await t.call(STRANGER, { action: "send-payment-received", tenant_phone: "9876543210" });
    expect(stranger.status).toBe(403);
  });

  it("send-welcome-message and send-rent-reminder: tenants of the caller's properties only", async () => {
    const t = setup();
    expect((await t.call(OWNER, { action: "send-welcome-message", tenant_phone: "9123456789" })).status).toBe(200);
    expect((await t.call(STRANGER, { action: "send-welcome-message", tenant_phone: "9123456789" })).status).toBe(403);
    expect((await t.call(STAFF, { action: "send-rent-reminder", tenant_ids: [TENANT_A] })).status).toBe(200);
    expect((await t.call(STRANGER, { action: "send-rent-reminder", tenant_ids: [TENANT_A] })).status).toBe(403);
  });

  it("send-mess-reminder: the caller's mess members only", async () => {
    const t = setup();
    expect((await t.call(OWNER, { action: "send-mess-reminder", member_phone: "9555500000" })).status).toBe(200);
    expect((await t.call(OWNER, { action: "send-mess-reminder", member_phone: "9999999999" })).status).toBe(403);
    expect((await t.call(STRANGER, { action: "send-mess-reminder", member_phone: "9555500000" })).status).toBe(403);
  });
});

describe("bytesToBase64", () => {
  it("matches Node's encoder, including inputs larger than one chunk", () => {
    const bytes = Uint8Array.from({ length: 70_000 }, (_, i) => (i * 31) % 256);
    expect(bytesToBase64(bytes)).toBe(Buffer.from(bytes).toString("base64"));
  });
});

describe("official WhatsApp Cloud API (Meta) first, then the fallbacks", () => {
  const MEDIA_OK = { status: 200, body: { id: "media-123" } };
  const SENT = { status: 200, body: { messages: [{ id: "wamid.1" }] } };

  it("sends the receipt as the approved payment_receipt template with the PDF, and skips the WA server", async () => {
    const t = setup({ cloud: { media: MEDIA_OK, messages: SENT } });
    const resp = await t.call(OWNER, receiptBody(PAID));
    expect(await resp.json()).toMatchObject({ sent: true, via: "document" });
    expect(t.calls.map((c) => c.url)).toEqual([
      "https://graph.facebook.com/v25.0/1553178531205507/media",
      "https://graph.facebook.com/v25.0/1553178531205507/messages",
    ]);
    expect(t.calls[0].body).toMatchObject({ messaging_product: "whatsapp", type: "application/pdf" });
    const msg = t.calls[1].body as { to: string; template: { name: string; components: { type: string; parameters: { type: string; text?: string; document?: { id: string; filename: string } }[] }[] } };
    expect(msg.to).toBe("919876543210");
    expect(msg.template.name).toBe("payment_receipt");
    const [header, body] = msg.template.components;
    expect(header.parameters[0].document?.id).toBe("media-123");
    expect(header.parameters[0].document?.filename).toMatch(/^PGB-11111111-.+\.pdf$/);
    expect(body.parameters.map((p) => p.text)).toEqual(["Ravi", "8,500.00", expect.any(String), expect.any(String)]);
  });

  it("falls back to the WA server while Meta has not approved the template yet", async () => {
    const t = setup({ cloud: { media: MEDIA_OK, messages: { status: 400, body: { error: { code: 132001, message: "Template name does not exist in the translation" } } } } });
    const resp = await t.call(OWNER, receiptBody(PAID));
    expect(await resp.json()).toMatchObject({ sent: true, via: "document" });
    expect(t.calls.map((c) => c.url).at(-1)).toBe("https://wa.pgbuddy.example/api/send-document");
  });

  it("stops at 'not on WhatsApp' instead of trying other routes", async () => {
    const t = setup({ cloud: { media: MEDIA_OK, messages: { status: 400, body: { error: { code: 131026, message: "Message undeliverable" } } } } });
    const resp = await t.call(OWNER, receiptBody(PAID));
    expect(await resp.json()).toMatchObject({ sent: false, reason: "not_on_whatsapp" });
    expect(t.calls.some((c) => c.url.includes("wa.pgbuddy.example"))).toBe(false);
  });

  it("sends rent reminders through the rent_reminder template", async () => {
    const t = setup({ cloud: { messages: SENT } });
    const resp = await t.call(OWNER, { action: "send-rent-reminder", tenant_ids: [TENANT_A], amount: 8500, month: "2026-12", property_name: "Sunrise PG", due_date: "5 Dec 2026" });
    expect(await resp.json()).toMatchObject({ sent: 1 });
    const msg = t.calls.find((c) => c.url.endsWith("/messages"))?.body as { template: { name: string; components: { parameters: { text: string }[] }[] } };
    expect(msg.template.name).toBe("rent_reminder");
    expect(msg.template.components[0].parameters.map((p) => p.text)).toEqual([expect.any(String), "8,500.00", "Dec 2026", "Sunrise PG", "5 Dec 2026"]);
    expect(t.calls.some((c) => c.url.includes("wa.pgbuddy.example"))).toBe(false);
  });
});


describe("every WhatsApp message goes through its approved template first", () => {
  const SENT = { status: 200, body: { messages: [{ id: "wamid.1" }] } };
  type Msg = { to: string; template: { name: string; components: { type: string; parameters: { text: string }[] }[] } };
  const sentTemplates = (calls: Call[]) =>
    calls.filter((c) => c.url.endsWith("/messages")).map((c) => c.body as unknown as Msg);
  const values = (m: Msg) => m.template.components[0].parameters.map((p) => p.text);
  const byName = Object.fromEntries(Object.values(TEMPLATES).map((d) => [d.name, d]));

  const cases: Array<{ what: string; caller: string; body: Record<string, unknown>; template: string; to: string[]; values: string[] }> = [
    {
      what: "automatic overdue rent reminder (name looked up, ISO due date formatted)",
      caller: OWNER,
      body: { action: "send-rent-reminder", tenant_ids: [TENANT_A], tenant_phone: "9876543210", amount: 8500, month: "2026-12", property_name: "Sunrise PG", due_date: "2026-12-05", reminder_type: "overdue" },
      template: "rent_overdue",
      to: ["919876543210"],
      values: ["Ravi Kumar", "8,500.00", "Dec 2026", "Sunrise PG", "05 Dec 2026"],
    },
    {
      what: "announcement to every tenant of the property",
      caller: OWNER,
      body: { action: "send-announcement", property_id: "prop-1", property_name: "Sunrise PG", title: "Water supply", content: "Off on Sunday 10-1." },
      template: "pg_notice",
      to: ["919876543210", "919123456789"],
      values: ["Sunrise PG", "Water supply", "Off on Sunday 10-1."],
    },
    {
      what: "welcome message",
      caller: OWNER,
      body: { action: "send-welcome-message", tenant_phone: "9876543210", tenant_name: "Ravi Kumar", property_name: "Sunrise PG", room_number: "104" },
      template: "tenant_welcome",
      to: ["919876543210"],
      values: ["Ravi Kumar", "Sunrise PG", "104"],
    },
    {
      what: "complaint alert to the owner",
      caller: TENANT_A,
      body: { action: "send-complaint-alert", property_id: "prop-1", title: "Tap leaking", category: "Plumbing", tenant_name: "Ravi Kumar", room_number: "104" },
      template: "complaint_alert",
      to: ["919000000001"],
      values: ["Sunrise PG", "Ravi Kumar", "104", "Plumbing", "Tap leaking"],
    },
    {
      what: "move-out alert to the owner",
      caller: TENANT_A,
      body: { action: "send-vacancy-alert", property_id: "prop-1", tenant_name: "Ravi Kumar", expected_move_out: "2026-12-31" },
      template: "vacancy_alert",
      to: ["919000000001"],
      values: ["Sunrise PG", "Ravi Kumar", "31 Dec 2026"],
    },
    {
      what: "payment proof submitted, to the owner",
      caller: TENANT_A,
      body: { action: "send-payment-approval", property_id: "prop-1", tenant_name: "Ravi Kumar", room_number: "104", amount: 8500, month: "2026-11" },
      template: "payment_proof_submitted",
      to: ["919000000001"],
      values: ["Sunrise PG", "Ravi Kumar", "104", "8,500.00", "Nov 2026"],
    },
    {
      what: "mess bill reminder",
      caller: OWNER,
      body: { action: "send-mess-reminder", member_phone: "9555500000", member_name: "Asha", amount: 3200, month: "2026-11", mess_name: "Sunrise Mess" },
      template: "mess_bill_reminder",
      to: ["919555500000"],
      values: ["Asha", "3,200.00", "Nov 2026", "Sunrise Mess"],
    },
  ];

  for (const c of cases) {
    it(c.what, async () => {
      const t = setup({ cloud: { messages: SENT } });
      const resp = await t.call(c.caller, c.body);
      expect(resp.status).toBe(200);
      expect(await resp.json()).toMatchObject({ sent: c.to.length });
      const msgs = sentTemplates(t.calls);
      expect(msgs.map((m) => m.to)).toEqual(c.to);
      for (const m of msgs) {
        expect(m.template.name).toBe(c.template);
        expect(values(m)).toEqual(c.values);
        // The count Meta approved, so Meta cannot refuse the message for a wrong number of values.
        expect(values(m)).toHaveLength(placeholderCount(byName[c.template].body));
      }
      expect(t.calls.some((x) => x.url.includes("wa.pgbuddy.example"))).toBe(false);
    });
  }

  it("falls back to the WhatsApp server while a template is not approved, for one message and for many", async () => {
    const notReady = { status: 400, body: { error: { code: 132001, message: "Template name does not exist in the translation" } } };
    const t = setup({ cloud: { messages: notReady } });
    await t.call(OWNER, cases[2].body);
    expect(t.calls.map((c) => c.url).filter((u) => u.includes("wa.pgbuddy.example"))).toEqual(["https://wa.pgbuddy.example/api/send-instant"]);

    const t2 = setup({ cloud: { messages: notReady } });
    const resp = await t2.call(OWNER, cases[1].body);
    expect(await resp.json()).toMatchObject({ total: 2 });
    const bulk = t2.calls.find((c) => c.url.endsWith("/api/bulk-message"));
    expect(bulk).toBeTruthy();
  });

  it("does not retry elsewhere when the number is not on WhatsApp", async () => {
    const t = setup({ cloud: { messages: { status: 400, body: { error: { code: 131026, message: "Message undeliverable" } } } } });
    const resp = await t.call(OWNER, cases[2].body);
    expect(await resp.json()).toMatchObject({ sent: 0 });
    expect(t.calls.some((x) => x.url.includes("wa.pgbuddy.example"))).toBe(false);
  });
});
