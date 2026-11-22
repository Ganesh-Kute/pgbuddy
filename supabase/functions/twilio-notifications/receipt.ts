// Action send-payment-receipt: the rent receipt as a PDF on WhatsApp, or as a download.
//
// The request carries only { payment_id, mode }. Everything printed on the receipt, and the phone it
// goes to, is read here from the database with the service role. Before this action, the app sent
// tenant_phone, amount and month itself, so any signed-in user could send a "Payment Received" message
// with any text to any number.
//
// Who may call it:
//   - the owner of the payment's property, or an active staff member of it (any mode);
//   - the tenant the payment belongs to (rent_payments.tenant_id = caller), for their own receipt only;
//   - a cron or service caller.
// Only paid payments have a receipt. A payment can be sent at most once a minute and 3 times an hour,
// counted from audit_logs, so the WhatsApp number cannot be used to spam a tenant.

import { buildReceipt, type ReceiptModel } from "../_shared/receipt-model.ts";
import { renderReceiptPdf, type PdfLib } from "../_shared/receipt-pdf.ts";
import { isUuid, jsonResponse, normalizeIndianPhone10 } from "../_shared/security.ts";

type Row = Record<string, unknown>;
type DbError = { message: string } | null;

export interface ReceiptQuery extends PromiseLike<{ data: Row[] | null; error: DbError }> {
  eq(column: string, value: unknown): ReceiptQuery;
  in(column: string, values: unknown[]): ReceiptQuery;
  gte(column: string, value: unknown): ReceiptQuery;
  order(column: string, options: { ascending: boolean }): ReceiptQuery;
  limit(count: number): ReceiptQuery;
  maybeSingle(): PromiseLike<{ data: Row | null; error: DbError }>;
}

/** The service-role Supabase client, as far as this action uses it. */
export interface ReceiptDb {
  from(table: string): {
    select(columns: string): ReceiptQuery;
    insert(row: Row): PromiseLike<{ error: DbError }>;
  };
}

export type DocumentSendResult = "sent" | "not_on_whatsapp" | "failed";

export interface ReceiptDeps {
  db: ReceiptDb;
  /** The signed-in caller, or null for a cron/service caller. */
  callerId: string | null;
  pdfLib: PdfLib;
  /** Send the PDF as a WhatsApp document. phone10 is a 10-digit Indian number. */
  sendDocument(phone10: string, doc: { base64: string; filename: string; caption: string }): Promise<DocumentSendResult>;
  /** Today's text message with a link, the fallback when the document cannot be sent. */
  sendLink(phone10: string, receipt: ReceiptModel, url: string): Promise<boolean>;
  /** Where the public receipt page lives, e.g. https://pgbuddy-zeta-rust.vercel.app */
  appUrl: string;
  corsHeaders: Record<string, string>;
  now?: () => Date;
}

/** Sends per payment: at most one a minute, three an hour. */
export const RECEIPT_COOLDOWN_MS = 60_000;
export const RECEIPT_MAX_PER_HOUR = 3;
/** audit_logs.table_name for receipt sends. Logged as action INSERT so the Audit Logs page shows "Created". */
export const RECEIPT_SEND_LOG = "receipt_sends";

const PAYMENT_COLUMNS =
  "id, amount, month, payment_date, created_at, status, payment_type, payment_method, transaction_id, tenant_id, tenant_name, tenant_phone, property_id, room_id";

const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");

/** Uint8Array to base64 without Node's Buffer, so it runs in Deno and in vitest alike. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function receiptCaption(r: ReceiptModel): string {
  const line = r.lines[0]?.label ?? r.title;
  return `🧾 *${r.title}*\n\nHi ${r.tenantName},\nYour payment of ${r.totalText} (${line}) at ${r.propertyName} is received.\nReceipt no. ${r.receiptNo}, ${r.issuedOn}.\n\n_PG Buddy_`;
}

async function callerCanManage(db: ReceiptDb, callerId: string, propertyId: string, ownerId: string): Promise<boolean> {
  if (callerId === ownerId) return true;
  const { data } = await db
    .from("staff_members")
    .select("id, property_id")
    .eq("owner_id", ownerId)
    .eq("staff_user_id", callerId)
    .eq("status", "active");
  return (data ?? []).some((s) => s.property_id === null || s.property_id === propertyId);
}

/** The tenant's name and phone, from the database only. Assignment first: it is what the owner keeps current. */
async function tenantParty(db: ReceiptDb, payment: Row): Promise<{ name: string; phone10: string | null }> {
  const tenantId = str(payment.tenant_id);
  const paymentPhone = normalizeIndianPhone10(str(payment.tenant_phone));
  const { data: assignments } = await db
    .from("tenant_assignments")
    .select("tenant_id, tenant_name, tenant_phone, room_id, is_active")
    .eq("property_id", str(payment.property_id))
    .limit(500);
  const rows = assignments ?? [];
  const matches = (a: Row) =>
    tenantId ? a.tenant_id === tenantId : !!paymentPhone && normalizeIndianPhone10(str(a.tenant_phone)) === paymentPhone;
  const assignment = rows.find((a) => matches(a) && a.is_active === true) ?? rows.find(matches) ?? null;

  let profile: Row | null = null;
  if (tenantId) {
    ({ data: profile } = await db.from("profiles").select("full_name, phone").eq("user_id", tenantId).maybeSingle());
  }

  const phone10 =
    normalizeIndianPhone10(str(assignment?.tenant_phone)) ??
    normalizeIndianPhone10(str(profile?.phone)) ??
    paymentPhone;
  const name = str(payment.tenant_name) || str(assignment?.tenant_name) || str(profile?.full_name);
  return { name, phone10 };
}

export async function handlePaymentReceipt(payload: { payment_id?: unknown; mode?: unknown }, deps: ReceiptDeps): Promise<Response> {
  const { db, callerId, corsHeaders } = deps;
  const now = deps.now ?? (() => new Date());
  const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
    jsonResponse(body, status, { ...corsHeaders, ...extra });

  const paymentId = str(payload.payment_id).trim();
  if (!isUuid(paymentId)) return json({ error: "A valid payment_id is required" }, 400);
  const mode = payload.mode === undefined || payload.mode === null || payload.mode === "" ? "send" : str(payload.mode);
  if (mode !== "send" && mode !== "download") return json({ error: 'mode must be "send" or "download"' }, 400);

  const { data: payment, error: paymentError } = await db
    .from("rent_payments")
    .select(PAYMENT_COLUMNS)
    .eq("id", paymentId)
    .maybeSingle();
  if (paymentError) {
    console.error("[receipt] payment lookup failed:", paymentError.message);
    return json({ error: "Could not load the payment" }, 500);
  }
  if (!payment) return json({ error: "Payment not found" }, 404);

  const propertyId = str(payment.property_id);
  const { data: property } = await db.from("properties").select("name, address, owner_id").eq("id", propertyId).maybeSingle();
  const ownerId = str(property?.owner_id);
  if (!property || !ownerId) return json({ error: "Payment not found" }, 404);

  // Authorise before saying anything about the payment's status.
  if (callerId !== null) {
    const isOwnTenant = !!str(payment.tenant_id) && payment.tenant_id === callerId;
    if (!isOwnTenant && !(await callerCanManage(db, callerId, propertyId, ownerId))) {
      return json({ error: "Forbidden: not your payment" }, 403);
    }
  }

  if (str(payment.status).toLowerCase() !== "paid") {
    return json({ sent: false, reason: "not_paid", error: "A receipt is only available once the payment is marked paid" }, 409);
  }

  const [{ data: room }, { data: owner }, tenant] = await Promise.all([
    str(payment.room_id)
      ? db.from("rooms").select("room_number").eq("id", str(payment.room_id)).maybeSingle()
      : Promise.resolve({ data: null as Row | null, error: null }),
    db.from("profiles").select("full_name, phone").eq("user_id", ownerId).maybeSingle(),
    tenantParty(db, payment),
  ]);

  const receipt = buildReceipt(
    {
      id: paymentId,
      amount: payment.amount as number | string,
      month: str(payment.month) || null,
      payment_date: str(payment.payment_date) || null,
      created_at: str(payment.created_at) || null,
      status: str(payment.status),
      payment_type: str(payment.payment_type) || null,
      payment_method: str(payment.payment_method) || null,
      transaction_id: str(payment.transaction_id) || null,
    },
    {
      tenantName: tenant.name || null,
      propertyName: str(property.name) || null,
      propertyAddress: str(property.address) || null,
      ownerName: str(owner?.full_name) || null,
      ownerPhone: str(owner?.phone) || null,
      roomNumber: str(room?.room_number) || null,
    },
    now(),
  );
  const pdf = await renderReceiptPdf(deps.pdfLib, receipt, now());

  if (mode === "download") {
    return new Response(pdf, {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${receipt.fileName}"`,
        "Cache-Control": "no-store",
      },
    });
  }

  // Cooldown, counted from the sends already logged for this payment.
  const hourAgo = new Date(now().getTime() - 3_600_000).toISOString();
  const { data: recent } = await db
    .from("audit_logs")
    .select("created_at")
    .eq("table_name", RECEIPT_SEND_LOG)
    .eq("record_id", paymentId)
    .gte("created_at", hourAgo)
    .order("created_at", { ascending: false })
    .limit(RECEIPT_MAX_PER_HOUR);
  const sends = (recent ?? []).map((r) => new Date(str(r.created_at)).getTime()).filter(Number.isFinite);
  const sinceLast = sends.length ? now().getTime() - Math.max(...sends) : Infinity;
  if (sends.length >= RECEIPT_MAX_PER_HOUR || sinceLast < RECEIPT_COOLDOWN_MS) {
    const waitMs = sends.length >= RECEIPT_MAX_PER_HOUR
      ? Math.min(...sends) + 3_600_000 - now().getTime()
      : RECEIPT_COOLDOWN_MS - sinceLast;
    const retry = Math.max(1, Math.ceil(waitMs / 1000));
    return json({ sent: false, reason: "cooldown", retry_after_seconds: retry }, 429, { "Retry-After": String(retry) });
  }

  if (!tenant.phone10) return json({ sent: false, via: null, reason: "no_phone" });

  let via: "document" | "link" | null = null;
  const docResult = await deps.sendDocument(tenant.phone10, {
    base64: bytesToBase64(pdf),
    filename: receipt.fileName,
    caption: receiptCaption(receipt),
  });
  if (docResult === "sent") via = "document";
  else if (docResult === "not_on_whatsapp") return json({ sent: false, via: null, reason: "not_on_whatsapp" });
  else if (await deps.sendLink(tenant.phone10, receipt, `${deps.appUrl.replace(/\/+$/, "")}/receipt/${paymentId}`)) via = "link";

  if (!via) return json({ sent: false, via: null, reason: "send_failed" });

  const { error: logError } = await db.from("audit_logs").insert({
    user_id: callerId ?? ownerId,
    action: "INSERT",
    table_name: RECEIPT_SEND_LOG,
    record_id: paymentId,
    property_id: propertyId,
    description: `Receipt ${receipt.receiptNo} sent to ${receipt.tenantName} on WhatsApp (${via === "document" ? "PDF" : "link"})`,
    new_data: { via, receipt_no: receipt.receiptNo },
  });
  if (logError) console.warn("[receipt] could not log the send:", logError.message);

  return json({ sent: true, via, receipt_no: receipt.receiptNo });
}
