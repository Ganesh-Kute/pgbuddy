import { cloudConfigFromEnv, sendReceiptDocument, sendRentReminder, sendTextTemplate, type CloudConfig } from "../_shared/whatsapp-cloud.ts";
import { TEMPLATES, type TemplateDef } from "../_shared/whatsapp-templates.ts";
import { formatIndiaDate, formatIndianNumber, formatPeriod } from "../_shared/receipt-model.ts";
import {
  ConfigError,
  type EnvGetter,
  defaultGetEnv,
  extractBearerToken,
  handleCorsAndOrigin,
  jsonResponse,
  normalizeIndianPhone10,
  requireEnv,
  requireSecretEnv,
  verifyCronOrServiceAuth,
} from "../_shared/security.ts";
import type { PdfLib } from "../_shared/receipt-pdf.ts";
import { handlePaymentReceipt, type DocumentSendResult, type ReceiptDb } from "./receipt.ts";

interface AuthUser {
  id: string;
  email?: string | null;
  phone?: string | null;
}

interface QueryResult<T = Record<string, unknown>> {
  data: T[] | null;
  error: { message: string } | null;
}

interface SingleResult<T = Record<string, unknown>> {
  data: T | null;
  error: { message: string } | null;
}

export interface TwilioQueryChain {
  eq(col: string, val: unknown): TwilioQueryChain;
  in(col: string, vals: unknown[]): TwilioQueryChain;
  or(filter: string): TwilioQueryChain;
  limit(n: number): PromiseLike<QueryResult> & TwilioQueryChain;
  maybeSingle(): Promise<SingleResult>;
  single(): Promise<SingleResult>;
  then<TResult1 = QueryResult, TResult2 = never>(
    onfulfilled?: ((value: QueryResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2>;
}

export interface TwilioSupabaseClient {
  auth: {
    getUser(): Promise<{ data: { user: AuthUser | null }; error: { message: string } | null }>;
  };
  from(table: string): {
    select(columns: string): TwilioQueryChain;
  };
}

export type CreateTwilioClientFn = (
  url: string,
  key: string,
  options?: { global: { headers: { Authorization: string } } },
) => TwilioSupabaseClient;

export interface TwilioNotificationsDeps {
  createClient: CreateTwilioClientFn;
  fetchFn?: typeof fetch;
  getEnv?: EnvGetter;
  /** pdf-lib, for send-payment-receipt. index.ts passes npm:pdf-lib; tests pass the npm package. */
  pdfLib?: PdfLib;
  /** The clock, for the receipt send cooldown. Tests pass a fixed one. */
  nowFn?: () => Date;
}

interface WaProviderConfig {
  /** Meta's official Cloud API: tried first for templates it has approved. */
  cloud: CloudConfig | null;
  waServerUrl: string | null;
  waServerSecret: string | null;
  interaktApiKey: string | null;
}

interface TwilioPayload {
  action?: unknown;
  /** Rent reminder: when the rent is due, e.g. "5 Dec 2026". */
  due_date?: unknown;
  reminder_type?: unknown;
  property_id?: unknown;
  tenant_ids?: unknown;
  tenant_phone?: unknown;
  tenant_name?: unknown;
  property_name?: unknown;
  room_number?: unknown;
  amount?: unknown;
  month?: unknown;
  title?: unknown;
  content?: unknown;
  category?: unknown;
  expected_move_out?: unknown;
  receipt_url?: unknown;
  member_phone?: unknown;
  member_name?: unknown;
  mess_name?: unknown;
  payment_id?: unknown;
  mode?: unknown;
}

const OWNER_STAFF_ACTIONS = new Set([
  "send-rent-reminder",
  "send-announcement",
  "send-payment-received",
  "send-mess-reminder",
  "send-welcome-message",
]);

const TENANT_OR_STAFF_ACTIONS = new Set([
  "send-complaint-alert",
  "send-vacancy-alert",
  "send-payment-approval",
]);

function asStr(val: unknown, fallback = ""): string {
  return typeof val === "string" ? val : typeof val === "number" ? String(val) : fallback;
}

async function sendBulkWhatsApp(
  phones: string[],
  templateName: string,
  bodyValuesList: string[][],
  messageTemplate: string,
  cfg: WaProviderConfig,
  fetchFn: typeof fetch,
): Promise<number> {
  if (cfg.waServerUrl && cfg.waServerSecret && phones.length > 0) {
    try {
      const resp = await fetchFn(`${cfg.waServerUrl}/api/bulk-message`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-server-secret": cfg.waServerSecret,
          "Bypass-Tunnel-Reminder": "true",
        },
        body: JSON.stringify({
          phoneNumbers: phones,
          message: messageTemplate,
          templateType: templateName,
        }),
      });

      const rawText = await resp.text();
      let data: { success?: boolean } = {};
      try {
        data = JSON.parse(rawText) as { success?: boolean };
      } catch {
        // non-JSON tunnel HTML
      }

      if (resp.ok && data.success) {
        return phones.length;
      }
      console.warn(`[WA Server] Queue error HTTP ${resp.status}`);
    } catch (err: unknown) {
      console.warn("[WA Server] Unreachable:", err instanceof Error ? err.message : String(err));
    }
  }

  if (!cfg.interaktApiKey) {
    return 0;
  }

  let sentCount = 0;
  for (let i = 0; i < phones.length; i++) {
    const cleanPhone = phones[i].replace(/\D/g, "").slice(-10);
    if (cleanPhone.length < 10) continue;
    const bodyValues = bodyValuesList[i] || bodyValuesList[0] || [];
    try {
      const resp = await fetchFn("https://api.interakt.ai/v1/public/message/", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Basic ${cfg.interaktApiKey}`,
        },
        body: JSON.stringify({
          countryCode: "+91",
          phoneNumber: cleanPhone,
          callbackData: "pg_notification",
          type: "Template",
          template: {
            name: templateName,
            languageCode: "en",
            bodyValues,
          },
        }),
      });
      if (resp.ok) sentCount++;
    } catch {
      console.error("Interakt bulk send error");
    }
  }
  return sentCount;
}

/**
 * One message: Meta's official API with an approved template first; if that does not deliver (template
 * not approved yet, Meta down or blocking), the older providers via `fallback`. A number that is not on
 * WhatsApp is not retried elsewhere.
 */
async function sendCloudFirst(
  to: string,
  template: { def: TemplateDef; values: string[] },
  cfg: WaProviderConfig,
  fetchFn: typeof fetch,
  fallback: () => Promise<boolean>,
): Promise<boolean> {
  if (cfg.cloud) {
    const res = await sendTextTemplate(cfg.cloud, to, template.def, template.values, fetchFn);
    if (res.ok) return true;
    console.warn(`[WA Cloud] ${template.def.name} not sent (${res.reason}): ${res.detail ?? ""}`);
    if (res.reason === "not_on_whatsapp") return false;
  }
  return fallback();
}

/** "2026-11-05" -> "05 Nov 2026"; anything else is shown as given. */
function dueDateText(raw: string): string {
  return /^\d{4}-\d{2}-\d{2}/.test(raw) ? formatIndiaDate(raw) : raw;
}

async function sendSingleWhatsApp(
  to: string,
  templateName: string,
  bodyValues: string[],
  messageText: string,
  cfg: WaProviderConfig,
  fetchFn: typeof fetch,
): Promise<boolean> {
  const cleanPhone = to.replace(/\D/g, "").slice(-10);
  if (cleanPhone.length < 10) return false;

  if (cfg.waServerUrl && cfg.waServerSecret) {
    try {
      const formattedPhone = `91${cleanPhone}`;
      const resp = await fetchFn(`${cfg.waServerUrl}/api/send-instant`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-server-secret": cfg.waServerSecret,
          "Bypass-Tunnel-Reminder": "true",
        },
        body: JSON.stringify({ phoneNumber: formattedPhone, message: messageText }),
      });
      if (resp.ok) return true;
      console.warn(`[WA Instant] Rejected with HTTP ${resp.status}`);
    } catch (err: unknown) {
      console.warn("[WA Instant] Error:", err instanceof Error ? err.message : String(err));
    }
  }

  if (!cfg.interaktApiKey) {
    return false;
  }

  try {
    const resp = await fetchFn("https://api.interakt.ai/v1/public/message/", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${cfg.interaktApiKey}`,
      },
      body: JSON.stringify({
        countryCode: "+91",
        phoneNumber: cleanPhone,
        callbackData: "pg_notification",
        type: "Template",
        template: { name: templateName, languageCode: "en", bodyValues },
      }),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

async function isOwnerOrStaffForProperty(
  supabase: TwilioSupabaseClient,
  userId: string,
  propertyId: string,
): Promise<{ allowed: boolean; propertyExists: boolean; ownerId?: string }> {
  const { data: prop } = await supabase
    .from("properties")
    .select("owner_id")
    .eq("id", propertyId)
    .maybeSingle();

  if (!prop || typeof prop.owner_id !== "string") {
    return { allowed: false, propertyExists: false };
  }
  if (prop.owner_id === userId) {
    return { allowed: true, propertyExists: true, ownerId: prop.owner_id };
  }

  const { data: staffRows } = await supabase
    .from("staff_members")
    .select("id, property_id")
    .eq("owner_id", prop.owner_id)
    .eq("staff_user_id", userId)
    .eq("status", "active");

  const hasAccess = (staffRows ?? []).some(
    (s) => s.property_id === null || s.property_id === propertyId,
  );
  return { allowed: hasAccess, propertyExists: true, ownerId: prop.owner_id };
}

async function isOwnerOrActiveStaffAny(
  supabase: TwilioSupabaseClient,
  userId: string,
): Promise<boolean> {
  const { data: roleRows } = await supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .eq("role", "owner")
    .limit(1);

  if ((roleRows ?? []).length > 0) return true;

  const { data: propRows } = await supabase
    .from("properties")
    .select("id")
    .eq("owner_id", userId)
    .limit(1);

  if ((propRows ?? []).length > 0) return true;

  const { data: staffRows } = await supabase
    .from("staff_members")
    .select("id")
    .eq("staff_user_id", userId)
    .eq("status", "active")
    .limit(1);

  return (staffRows ?? []).length > 0;
}

async function isAssignedTenantForProperty(
  supabase: TwilioSupabaseClient,
  user: AuthUser,
  propertyId: string,
): Promise<boolean> {
  const { data: assignments } = await supabase
    .from("tenant_assignments")
    .select("id, tenant_id, tenant_email, tenant_phone")
    .eq("property_id", propertyId)
    .eq("is_active", true);

  const userEmail = user.email?.trim().toLowerCase() || "";
  const userPhone10 = user.phone ? normalizeIndianPhone10(user.phone) : null;

  return (assignments ?? []).some((row) => {
    if (row.tenant_id === user.id) return true;
    if (userEmail && typeof row.tenant_email === "string" && row.tenant_email.trim().toLowerCase() === userEmail) {
      return true;
    }
    if (userPhone10 && typeof row.tenant_phone === "string" && normalizeIndianPhone10(row.tenant_phone) === userPhone10) {
      return true;
    }
    return false;
  });
}

/** How long to wait for the WhatsApp server before falling back. Its browser session can hang. */
const WA_DOCUMENT_TIMEOUT_MS = 15_000;

/**
 * Send a PDF as a WhatsApp document through the WA server's POST /api/send-document.
 * "not_on_whatsapp" only for the server's own JSON 404 (the number has no WhatsApp). An older server
 * without the endpoint answers 404 with an HTML page, and that counts as "failed", so the caller falls
 * back to the link.
 */
async function sendWhatsAppDocument(
  phone10: string,
  doc: { base64: string; filename: string; caption: string },
  cfg: WaProviderConfig,
  fetchFn: typeof fetch,
): Promise<DocumentSendResult> {
  if (!cfg.waServerUrl || !cfg.waServerSecret) return "failed";
  // A plain controller and timer rather than AbortSignal.timeout, which some runtimes lack.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WA_DOCUMENT_TIMEOUT_MS);
  try {
    const resp = await fetchFn(`${cfg.waServerUrl}/api/send-document`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-server-secret": cfg.waServerSecret,
        "Bypass-Tunnel-Reminder": "true",
      },
      body: JSON.stringify({
        phoneNumber: `91${phone10}`,
        base64: doc.base64,
        mimetype: "application/pdf",
        filename: doc.filename,
        caption: doc.caption,
      }),
      signal: controller.signal,
    });
    let data: { sent?: unknown; success?: unknown; reason?: unknown } | null = null;
    try {
      data = JSON.parse(await resp.text());
    } catch {
      // A tunnel or proxy page, not the WA server.
    }
    if (resp.ok && data && (data.sent === true || data.success === true)) return "sent";
    if (resp.status === 404 && data) return "not_on_whatsapp";
    const reason = data && typeof data.reason === "string" ? `: ${data.reason.slice(0, 200)}` : "";
    console.warn(`[WA Document] Rejected with HTTP ${resp.status}${reason}`);
    return "failed";
  } catch (err: unknown) {
    console.warn("[WA Document] Error:", err instanceof Error ? err.message : String(err));
    return "failed";
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------------------------------
// Destination checks for the older actions that still take a phone number from the request.
// A signed-in owner or staff member may only message their own tenants and mess members. Before this,
// any account could claim the owner role at signup and send any text to any number.

/** Ids of the properties the caller owns, plus those an active staff membership covers. */
async function managedPropertyIds(supabase: TwilioSupabaseClient, userId: string): Promise<string[]> {
  const ids = new Set<string>();
  const { data: own } = await supabase.from("properties").select("id").eq("owner_id", userId);
  (own ?? []).forEach((p) => typeof p.id === "string" && ids.add(p.id));
  const { data: staff } = await supabase
    .from("staff_members")
    .select("owner_id, property_id")
    .eq("staff_user_id", userId)
    .eq("status", "active");
  const wholeOwners: string[] = [];
  for (const s of staff ?? []) {
    if (typeof s.property_id === "string") ids.add(s.property_id);
    else if (s.property_id === null && typeof s.owner_id === "string") wholeOwners.push(s.owner_id);
  }
  if (wholeOwners.length > 0) {
    const { data: props } = await supabase.from("properties").select("id").in("owner_id", wholeOwners);
    (props ?? []).forEach((p) => typeof p.id === "string" && ids.add(p.id));
  }
  return [...ids];
}

/** Tenants (current or past) of these properties: their assignment rows. */
async function tenantRowsOf(supabase: TwilioSupabaseClient, propertyIds: string[]) {
  if (propertyIds.length === 0) return [];
  const { data } = await supabase
    .from("tenant_assignments")
    .select("tenant_id, tenant_phone")
    .in("property_id", propertyIds);
  return data ?? [];
}

/** True when the phone is a tenant's, on one of these properties: the assignment's phone or the tenant's profile phone. */
async function isTenantPhoneOf(supabase: TwilioSupabaseClient, propertyIds: string[], phone: string): Promise<boolean> {
  const target = normalizeIndianPhone10(phone);
  if (!target) return false;
  const rows = await tenantRowsOf(supabase, propertyIds);
  if (rows.some((r) => typeof r.tenant_phone === "string" && normalizeIndianPhone10(r.tenant_phone) === target)) return true;
  const tenantIds = rows.map((r) => r.tenant_id).filter((v): v is string => typeof v === "string" && v.length > 0);
  if (tenantIds.length === 0) return false;
  const { data: profiles } = await supabase.from("profiles").select("user_id, phone").in("user_id", tenantIds);
  return (profiles ?? []).some((p) => typeof p.phone === "string" && normalizeIndianPhone10(p.phone) === target);
}

/** True when every id is a tenant of one of these properties. */
async function areTenantsOf(supabase: TwilioSupabaseClient, propertyIds: string[], tenantIds: string[]): Promise<boolean> {
  const known = new Set((await tenantRowsOf(supabase, propertyIds)).map((r) => r.tenant_id));
  return tenantIds.every((id) => known.has(id));
}

/** True when the phone belongs to a mess member of the caller, or of the owner the caller is active staff for. */
async function isMessMemberPhoneOf(supabase: TwilioSupabaseClient, userId: string, phone: string): Promise<boolean> {
  const target = normalizeIndianPhone10(phone);
  if (!target) return false;
  const ownerIds = new Set([userId]);
  const { data: staff } = await supabase
    .from("staff_members")
    .select("owner_id")
    .eq("staff_user_id", userId)
    .eq("status", "active");
  (staff ?? []).forEach((s) => typeof s.owner_id === "string" && ownerIds.add(s.owner_id));
  const { data: members } = await supabase.from("mess_members").select("phone").in("owner_id", [...ownerIds]);
  return (members ?? []).some((m) => typeof m.phone === "string" && normalizeIndianPhone10(m.phone) === target);
}

export function createTwilioNotificationsHandler({
  createClient,
  fetchFn = fetch,
  getEnv = defaultGetEnv,
  pdfLib,
  nowFn,
}: TwilioNotificationsDeps) {
  return async (req: Request): Promise<Response> => {
    const { corsHeaders, response: corsResp } = handleCorsAndOrigin(req, ["x-cron-secret"], getEnv);
    if (corsResp) return corsResp;

    if (req.method !== "POST") {
      return jsonResponse({ error: "Method not allowed" }, 405, corsHeaders);
    }

    try {
      const supabaseUrl = requireEnv("SUPABASE_URL", getEnv);
      const anonKey = requireEnv("SUPABASE_ANON_KEY", getEnv);
      const serviceRoleKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY", getEnv);

      // The public website, used in WhatsApp links (PUBLIC_APP_URL secret, no trailing slash).
      const appUrl = (getEnv("PUBLIC_APP_URL")?.trim() || "https://pgbuddy-zeta-rust.vercel.app").replace(/\/+$/, "");
      const waServerUrlRaw = getEnv("WA_SERVER_URL")?.trim() || null;
      const waServerUrl = waServerUrlRaw ? waServerUrlRaw.replace(/\/+$/, "") : null;
      const waServerSecret = waServerUrl ? requireSecretEnv("WA_SERVER_SECRET", getEnv) : null;
      const interaktApiKey = getEnv("INTERAKT_API_KEY")?.trim() || null;

      const cloud = cloudConfigFromEnv(getEnv);

      if (!cloud && !waServerUrl && !interaktApiKey) {
        throw new ConfigError(
          "Server configuration error: set WHATSAPP_TOKEN + WHATSAPP_PHONE_NUMBER_ID, WA_SERVER_URL + WA_SERVER_SECRET or INTERAKT_API_KEY",
        );
      }

      const providerCfg: WaProviderConfig = {
        cloud,
        waServerUrl,
        waServerSecret,
        interaktApiKey,
      };

      const serviceAuth = verifyCronOrServiceAuth(req, getEnv);
      let authUser: AuthUser | null = null;
      const isServiceCaller = serviceAuth.authorized;

      if (!isServiceCaller) {
        const token = extractBearerToken(req);
        if (token) {
          const userClient = createClient(supabaseUrl, anonKey, {
            global: { headers: { Authorization: `Bearer ${token}` } },
          });
          const { data: { user }, error: userError } = await userClient.auth.getUser();
          if (!userError && user) {
            authUser = user;
          }
        }
      }

      if (!isServiceCaller && !authUser) {
        if (!serviceAuth.authorized && req.headers.get("x-cron-secret") && serviceAuth.status === 500) {
          return jsonResponse({ error: serviceAuth.error || "Server configuration error" }, 500, corsHeaders);
        }
        return jsonResponse({ error: "Unauthorized" }, 401, corsHeaders);
      }

      let payload: TwilioPayload;
      try {
        payload = (await req.json()) as TwilioPayload;
      } catch {
        return jsonResponse({ error: "Invalid JSON payload" }, 400, corsHeaders);
      }

      const action = typeof payload.action === "string" ? payload.action.trim() : "";

      if (action === "send-payment-receipt") {
        // Its own authorisation: the caller is checked against the payment, not a property_id from the body.
        if (!pdfLib) throw new ConfigError("Server configuration error: pdf-lib is not loaded");
        const db = createClient(supabaseUrl, serviceRoleKey) as unknown as ReceiptDb;
        return await handlePaymentReceipt(payload, {
          db,
          callerId: isServiceCaller ? null : authUser?.id ?? null,
          pdfLib,
          corsHeaders,
          now: nowFn,
          appUrl,
          sendDocument: async (phone10, doc) => {
            // Official API first; until Meta approves payment_receipt (or if it is down) the
            // self-hosted WhatsApp server sends the same PDF.
            if (providerCfg.cloud) {
              const r = doc.receipt;
              const res = await sendReceiptDocument(providerCfg.cloud, phone10, doc.bytes, doc.filename, {
                tenantName: r.tenantName,
                amount: formatIndianNumber(r.total),
                period: r.period || r.lines[0]?.label || r.title,
                propertyName: r.propertyName,
              }, fetchFn);
              if (res.ok) return "sent";
              if (res.reason === "not_on_whatsapp") return "not_on_whatsapp";
              console.warn(`[WA Cloud] receipt not sent (${res.reason}): ${res.detail ?? ""}`);
            }
            return sendWhatsAppDocument(phone10, doc, providerCfg, fetchFn);
          },
          sendLink: (phone10, r, url) =>
            sendSingleWhatsApp(
              phone10,
              "payment_received",
              [r.tenantName, r.totalText, r.lines[0]?.label ?? r.title, r.propertyName, r.roomNumber, url],
              `💰 *Payment Received*\n\nHi ${r.tenantName},\nWe have received your payment of ${r.totalText} (${r.lines[0]?.label ?? r.title}).\nReceipt no. ${r.receiptNo}.\n\nView receipt: ${url}\n\n_PG Buddy App_`,
              providerCfg,
              fetchFn,
            ),
        });
      }
      if (!OWNER_STAFF_ACTIONS.has(action) && !TENANT_OR_STAFF_ACTIONS.has(action)) {
        return jsonResponse(
          {
            error: `Unknown action: ${action || "(missing)"}. Supported: send-payment-receipt, send-rent-reminder, send-announcement, send-complaint-alert, send-vacancy-alert, send-payment-approval, send-payment-received, send-mess-reminder, send-welcome-message`,
          },
          400,
          corsHeaders,
        );
      }

      const supabase = createClient(supabaseUrl, serviceRoleKey);

      if (authUser && !isServiceCaller) {
        const propertyId = asStr(payload.property_id).trim();

        if (action === "send-announcement") {
          if (!propertyId) {
            return jsonResponse({ error: "property_id is required" }, 400, corsHeaders);
          }
          const check = await isOwnerOrStaffForProperty(supabase, authUser.id, propertyId);
          if (!check.propertyExists) {
            return jsonResponse({ error: "Property not found" }, 404, corsHeaders);
          }
          if (!check.allowed) {
            return jsonResponse({ error: "Forbidden: owner or active staff required" }, 403, corsHeaders);
          }
        } else if (OWNER_STAFF_ACTIONS.has(action)) {
          if (propertyId) {
            const check = await isOwnerOrStaffForProperty(supabase, authUser.id, propertyId);
            if (!check.propertyExists) {
              return jsonResponse({ error: "Property not found" }, 404, corsHeaders);
            }
            if (!check.allowed) {
              return jsonResponse({ error: "Forbidden: owner or active staff required" }, 403, corsHeaders);
            }
          } else {
            const allowed = await isOwnerOrActiveStaffAny(supabase, authUser.id);
            if (!allowed) {
              return jsonResponse({ error: "Forbidden: owner or active staff required" }, 403, corsHeaders);
            }
          }
        } else if (TENANT_OR_STAFF_ACTIONS.has(action)) {
          if (!propertyId) {
            return jsonResponse({ error: "property_id is required" }, 400, corsHeaders);
          }
          const staffCheck = await isOwnerOrStaffForProperty(supabase, authUser.id, propertyId);
          if (!staffCheck.propertyExists) {
            return jsonResponse({ error: "Property not found" }, 404, corsHeaders);
          }
          if (!staffCheck.allowed) {
            const tenantAllowed = await isAssignedTenantForProperty(supabase, authUser, propertyId);
            if (!tenantAllowed) {
              return jsonResponse({ error: "Forbidden: not assigned to this property" }, 403, corsHeaders);
            }
          }
        }

        // Owner actions that take recipients from the request: only the caller's own tenants or members.
        if (OWNER_STAFF_ACTIONS.has(action) && action !== "send-announcement") {
          const scope = () => (propertyId ? Promise.resolve([propertyId]) : managedPropertyIds(supabase, authUser.id));
          const notYours = () =>
            jsonResponse({ error: "Forbidden: you can only message your own tenants" }, 403, corsHeaders);
          if (action === "send-mess-reminder") {
            const memberPhone = asStr(payload.member_phone).trim();
            if (memberPhone && !(await isMessMemberPhoneOf(supabase, authUser.id, memberPhone))) return notYours();
          } else {
            const tenantPhone = asStr(payload.tenant_phone).trim();
            const tenantIds = Array.isArray(payload.tenant_ids)
              ? payload.tenant_ids.filter((id): id is string => typeof id === "string" && id.trim().length > 0)
              : [];
            if (tenantPhone) {
              if (!(await isTenantPhoneOf(supabase, await scope(), tenantPhone))) return notYours();
            } else if (action === "send-rent-reminder" && tenantIds.length > 0) {
              if (!(await areTenantsOf(supabase, await scope(), tenantIds))) return notYours();
            }
          }
        }
      }

      if (action === "send-rent-reminder") {
        const tenantIds = Array.isArray(payload.tenant_ids)
          ? payload.tenant_ids.filter((id): id is string => typeof id === "string" && id.trim().length > 0)
          : [];
        const tenantPhone = asStr(payload.tenant_phone).trim();
        const tenantName = asStr(payload.tenant_name, "Tenant");
        const propertyName = asStr(payload.property_name, "Your PG");
        const roomNumber = asStr(payload.room_number, "N/A");
        const amount = asStr(payload.amount, "0");
        const month = asStr(payload.month, "this month");

        let recipients: { phone: string; full_name: string }[] = [];
        if (tenantPhone) {
          recipients.push({ phone: tenantPhone, full_name: tenantName || "Tenant" });
        } else if (tenantIds.length > 0) {
          const { data: profiles } = await supabase
            .from("profiles")
            .select("user_id, phone, full_name")
            .in("user_id", tenantIds);
          recipients = (profiles ?? [])
            .filter((p) => typeof p.phone === "string" && p.phone.trim().length > 0)
            .map((p) => ({
              phone: String(p.phone).trim(),
              full_name: typeof p.full_name === "string" && p.full_name ? p.full_name : "Tenant",
            }));
        }

        if (recipients.length === 0) {
          return jsonResponse({ sent: 0, message: "No recipients found" }, 200, corsHeaders);
        }

        // The automatic reminder sends the phone and account id but no name: look the name up.
        if (tenantPhone && !asStr(payload.tenant_name).trim() && tenantIds.length === 1) {
          const { data: prof } = await supabase.from("profiles").select("full_name").eq("user_id", tenantIds[0]).maybeSingle();
          if (typeof prof?.full_name === "string" && prof.full_name.trim()) recipients[0].full_name = prof.full_name.trim();
        }

        // Official API first, one template message per tenant; whoever it cannot reach (template not
        // approved yet, number not on WhatsApp, Meta down) goes through the older providers below.
        let cloudSent = 0;
        if (providerCfg.cloud) {
          const dueDate = dueDateText(asStr(payload.due_date).trim()) || "the agreed date";
          const overdue = asStr(payload.reminder_type) === "overdue";
          const period = formatPeriod(month) || month;
          const leftover: typeof recipients = [];
          for (const r of recipients) {
            const res = await sendRentReminder(providerCfg.cloud, r.phone, {
              tenantName: r.full_name || "Tenant",
              amount: formatIndianNumber(Number(amount) || 0),
              period,
              propertyName,
              dueDate,
              overdue,
            }, fetchFn);
            if (res.ok) cloudSent++;
            else {
              console.warn(`[WA Cloud] rent reminder not sent (${res.reason}): ${res.detail ?? ""}`);
              leftover.push(r);
            }
          }
          recipients = leftover;
          if (recipients.length === 0) {
            return jsonResponse({ sent: cloudSent, total: cloudSent }, 200, corsHeaders);
          }
        }

        const phonesList = recipients.map((r) => r.phone);
        const paramsList = recipients.map((t) => [
          t.full_name || "Tenant",
          amount || "0",
          propertyName,
          roomNumber,
          month,
        ]);
        const messageText = `🏠 *${propertyName} — Rent Reminder*\n\n────────────────────\nHi *${recipients[0]?.full_name || "Tenant"}* 👋\n\n💰 *Amount:* ₹${amount}\n📍 *Room:* ${roomNumber}\n📅 *Month:* ${month}\n\nPlease make the payment at your earliest convenience to avoid any late charges.\n────────────────────\n_Sent via PG Buddy_`;

        const sent = await sendBulkWhatsApp(
          phonesList,
          "rent_reminder",
          paramsList,
          messageText,
          providerCfg,
          fetchFn,
        );

        return jsonResponse({ sent: sent + cloudSent, total: recipients.length + cloudSent }, 200, corsHeaders);
      }

      if (action === "send-announcement") {
        const propertyId = asStr(payload.property_id).trim();
        const title = asStr(payload.title, "Update");
        const content = asStr(payload.content, "Please check your PG Buddy app for details.");
        const propertyName = asStr(payload.property_name, "Your PG");

        const { data: assignments } = await supabase
          .from("tenant_assignments")
          .select("tenant_id, tenant_phone")
          .eq("property_id", propertyId)
          .eq("is_active", true);

        const tenantIds = (assignments ?? [])
          .map((a) => (typeof a.tenant_id === "string" ? a.tenant_id : ""))
          .filter(Boolean);

        const profilePhoneMap: Record<string, string> = {};
        if (tenantIds.length > 0) {
          const { data: profiles } = await supabase
            .from("profiles")
            .select("user_id, phone, full_name")
            .in("user_id", tenantIds);
          for (const p of profiles ?? []) {
            if (typeof p.user_id === "string" && typeof p.phone === "string" && p.phone.trim()) {
              profilePhoneMap[p.user_id] = p.phone.trim();
            }
          }
        }

        const allRecipients: { phone: string }[] = [];
        const seenPhones = new Set<string>();
        for (const a of assignments ?? []) {
          const directPhone = typeof a.tenant_phone === "string" ? a.tenant_phone.trim() : "";
          const tid = typeof a.tenant_id === "string" ? a.tenant_id : "";
          const phone = directPhone || (tid ? profilePhoneMap[tid] : "");
          if (phone && !seenPhones.has(phone)) {
            seenPhones.add(phone);
            allRecipients.push({ phone });
          }
        }

        if (allRecipients.length === 0) {
          return jsonResponse({ sent: 0, message: "No tenants with phone numbers" }, 200, corsHeaders);
        }

        // Official API first; whoever it cannot reach goes through the older providers below.
        let cloudSent = 0;
        let pending = allRecipients;
        if (providerCfg.cloud) {
          pending = [];
          for (const r of allRecipients) {
            const res = await sendTextTemplate(providerCfg.cloud, r.phone, TEMPLATES.pgNotice, [propertyName, title, content], fetchFn);
            if (res.ok) cloudSent++;
            else {
              console.warn(`[WA Cloud] pg_notice not sent (${res.reason}): ${res.detail ?? ""}`);
              if (res.reason !== "not_on_whatsapp") pending.push(r);
            }
          }
          if (pending.length === 0) {
            return jsonResponse({ sent: cloudSent, total: allRecipients.length }, 200, corsHeaders);
          }
        }

        const phonesList = pending.map((r) => r.phone);
        const paramsList = pending.map(() => [title, content, propertyName]);
        const messageText = `📢 *${propertyName} — New Announcement*\n\n────────────────────\n📌 *${title}*\n\n${content}\n────────────────────\n_Sent via PG Buddy • ${propertyName}_`;

        const sent = await sendBulkWhatsApp(
          phonesList,
          "announcement",
          paramsList,
          messageText,
          providerCfg,
          fetchFn,
        );

        return jsonResponse({ sent: sent + cloudSent, total: allRecipients.length }, 200, corsHeaders);
      }

      if (action === "send-welcome-message") {
        const tenantPhone = asStr(payload.tenant_phone).trim();
        if (!tenantPhone) {
          return jsonResponse({ sent: 0, message: "No phone number provided" }, 200, corsHeaders);
        }
        const tenantName = asStr(payload.tenant_name, "Tenant");
        const propertyName = asStr(payload.property_name, "PG Buddy");
        const roomNumber = asStr(payload.room_number, "N/A");

        const params = [tenantName, propertyName, roomNumber, appUrl];
        const messageText = `👋 *Welcome to ${propertyName}!*\n\n────────────────────\nHi *${tenantName}*,\n\nYou’ve been assigned to:\n🏠 *Property:* ${propertyName}\n🚪 *Room:* ${roomNumber}\n\n📲 Access your dashboard, pay rent, and raise complaints anytime:\n${appUrl}\n────────────────────\n_Sent via PG Buddy_`;

        const ok = await sendCloudFirst(
          tenantPhone,
          { def: TEMPLATES.tenantWelcome, values: [tenantName, propertyName, roomNumber] },
          providerCfg,
          fetchFn,
          () => sendSingleWhatsApp(tenantPhone, "welcome_tenant", params, messageText, providerCfg, fetchFn),
        );

        return jsonResponse({ sent: ok ? 1 : 0, total: 1 }, 200, corsHeaders);
      }

      if (action === "send-complaint-alert") {
        const propertyId = asStr(payload.property_id).trim();
        const title = asStr(payload.title, "Issue reported");
        const category = asStr(payload.category, "General");
        const tenantName = asStr(payload.tenant_name, "A tenant");
        const roomNumber = asStr(payload.room_number, "N/A");
        // Only the owner and staff are told. The tenant who raised it sees it in the app and gets no
        // WhatsApp message (any tenant_phone in the request is ignored).

        const { data: property } = await supabase
          .from("properties")
          .select("owner_id, name")
          .eq("id", propertyId)
          .single();

        if (!property || typeof property.owner_id !== "string") {
          return jsonResponse({ error: "Property not found" }, 404, corsHeaders);
        }

        const { data: ownerProfile } = await supabase
          .from("profiles")
          .select("phone, full_name")
          .eq("user_id", property.owner_id)
          .maybeSingle();

        const categoryToRole: Record<string, string> = {
          plumbing: "plumber",
          electrical: "electrician",
          cleaning: "cleaner",
        };
        const matchingRole = categoryToRole[category.toLowerCase()] || null;
        const rolesToNotify = ["manager", "caretaker"];
        if (matchingRole) rolesToNotify.push(matchingRole);

        const { data: staff } = await supabase
          .from("staff_members")
          .select("staff_user_id, invited_phone")
          .eq("owner_id", property.owner_id)
          .in("status", ["active", "pending"])
          .or(`property_id.eq.${propertyId},property_id.is.null`)
          .in("role", rolesToNotify);

        const managerIds = (staff ?? [])
          .map((s) => (typeof s.staff_user_id === "string" ? s.staff_user_id : ""))
          .filter(Boolean);

        let managerPhones: { phone: string }[] = [];
        if (managerIds.length > 0) {
          const { data: mProfiles } = await supabase
            .from("profiles")
            .select("phone, full_name")
            .in("user_id", managerIds);
          managerPhones = (mProfiles ?? [])
            .filter((p) => typeof p.phone === "string" && p.phone.trim().length > 0)
            .map((p) => ({ phone: String(p.phone).trim() }));
        }

        const invitedPhones = (staff ?? [])
          .filter((s) => !s.staff_user_id && typeof s.invited_phone === "string" && s.invited_phone.trim().length > 0)
          .map((s) => ({ phone: String(s.invited_phone).trim() }));

        const ownerPhone = typeof ownerProfile?.phone === "string" ? ownerProfile.phone.trim() : "";
        const recipientsRaw: { phone: string }[] = [
          ...(ownerPhone ? [{ phone: ownerPhone }] : []),
          ...managerPhones,
          ...invitedPhones,
        ];

        const seenRaw = new Set<string>();
        const recipients: { phone: string }[] = [];
        for (const r of recipientsRaw) {
          if (!seenRaw.has(r.phone)) {
            seenRaw.add(r.phone);
            recipients.push(r);
          }
        }

        if (recipients.length === 0) {
          return jsonResponse({ sent: 0, message: "No owner/manager phone numbers" }, 200, corsHeaders);
        }

        const propName = typeof property.name === "string" && property.name ? property.name : "Your PG";
        const params = [tenantName, propName, roomNumber, title, category];
        const messageText = `🚨 *${propName} — Complaint Logged*\n\n────────────────────\n📝 *Issue:* ${title}\n🏷️ *Category:* ${category}\n👤 *Tenant:* ${tenantName}\n🚪 *Room:* ${roomNumber}\n\nThe staff has been notified and will resolve this shortly.\n────────────────────\n_Sent via PG Buddy_`;

        let sent = 0;
        for (const r of recipients) {
          const viaCloud = { def: TEMPLATES.complaintAlert, values: [propName, tenantName, roomNumber, category, title] };
          if (await sendCloudFirst(r.phone, viaCloud, providerCfg, fetchFn, () =>
            sendSingleWhatsApp(r.phone, "complaint_alert", params, messageText, providerCfg, fetchFn))) {
            sent++;
          }
        }

        return jsonResponse({ sent, total: recipients.length }, 200, corsHeaders);
      }

      if (action === "send-vacancy-alert") {
        const propertyId = asStr(payload.property_id).trim();
        const tenantName = asStr(payload.tenant_name, "A tenant");
        const expectedMoveOut = asStr(payload.expected_move_out, "Not specified");

        const { data: property } = await supabase
          .from("properties")
          .select("owner_id, name")
          .eq("id", propertyId)
          .single();

        if (!property || typeof property.owner_id !== "string") {
          return jsonResponse({ error: "Property not found" }, 404, corsHeaders);
        }

        const { data: ownerProfile } = await supabase
          .from("profiles")
          .select("phone, full_name")
          .eq("user_id", property.owner_id)
          .maybeSingle();

        const { data: staff } = await supabase
          .from("staff_members")
          .select("staff_user_id")
          .eq("owner_id", property.owner_id)
          .eq("status", "active")
          .in("role", ["manager"]);

        const managerIds = (staff ?? [])
          .map((s) => (typeof s.staff_user_id === "string" ? s.staff_user_id : ""))
          .filter(Boolean);

        let managerPhones: { phone: string }[] = [];
        if (managerIds.length > 0) {
          const { data: mProfiles } = await supabase
            .from("profiles")
            .select("phone, full_name")
            .in("user_id", managerIds);
          managerPhones = (mProfiles ?? [])
            .filter((p) => typeof p.phone === "string" && p.phone.trim().length > 0)
            .map((p) => ({ phone: String(p.phone).trim() }));
        }

        const ownerPhone = typeof ownerProfile?.phone === "string" ? ownerProfile.phone.trim() : "";
        const recipients = [
          ...(ownerPhone ? [{ phone: ownerPhone }] : []),
          ...managerPhones,
        ];

        if (recipients.length === 0) {
          return jsonResponse({ sent: 0, message: "No owner/manager phone numbers" }, 200, corsHeaders);
        }

        const propName = typeof property.name === "string" && property.name ? property.name : "Your PG";
        const params = [tenantName, propName, expectedMoveOut];
        const messageText = `🚪 *${propName} — Vacancy Alert*\n\n────────────────────\n👤 *Tenant:* ${tenantName}\n📅 *Expected move-out:* ${expectedMoveOut}\n\nA room will be available soon. Plan accordingly.\n────────────────────\n_Sent via PG Buddy_`;

        let sent = 0;
        for (const r of recipients) {
          const viaCloud = { def: TEMPLATES.vacancyAlert, values: [propName, tenantName, dueDateText(expectedMoveOut)] };
          if (await sendCloudFirst(r.phone, viaCloud, providerCfg, fetchFn, () =>
            sendSingleWhatsApp(r.phone, "announcement", params, messageText, providerCfg, fetchFn))) {
            sent++;
          }
        }

        return jsonResponse({ sent, total: recipients.length }, 200, corsHeaders);
      }

      if (action === "send-payment-approval") {
        const propertyId = asStr(payload.property_id).trim();
        const tenantName = asStr(payload.tenant_name, "A tenant");
        const roomNumber = asStr(payload.room_number, "N/A");
        const amount = asStr(payload.amount, "0");
        const month = asStr(payload.month, "this month");

        const { data: property } = await supabase
          .from("properties")
          .select("owner_id, name")
          .eq("id", propertyId)
          .single();

        if (!property || typeof property.owner_id !== "string") {
          return jsonResponse({ error: "Property not found" }, 404, corsHeaders);
        }

        const { data: ownerProfile } = await supabase
          .from("profiles")
          .select("phone, full_name")
          .eq("user_id", property.owner_id)
          .maybeSingle();

        const { data: staff } = await supabase
          .from("staff_members")
          .select("staff_user_id")
          .eq("owner_id", property.owner_id)
          .eq("status", "active")
          .in("role", ["manager"]);

        const managerIds = (staff ?? [])
          .map((s) => (typeof s.staff_user_id === "string" ? s.staff_user_id : ""))
          .filter(Boolean);

        let managerPhones: { phone: string }[] = [];
        if (managerIds.length > 0) {
          const { data: mProfiles } = await supabase
            .from("profiles")
            .select("phone, full_name")
            .in("user_id", managerIds);
          managerPhones = (mProfiles ?? [])
            .filter((p) => typeof p.phone === "string" && p.phone.trim().length > 0)
            .map((p) => ({ phone: String(p.phone).trim() }));
        }

        const ownerPhone = typeof ownerProfile?.phone === "string" ? ownerProfile.phone.trim() : "";
        const recipients = [
          ...(ownerPhone ? [{ phone: ownerPhone }] : []),
          ...managerPhones,
        ];

        if (recipients.length === 0) {
          return jsonResponse({ sent: 0, message: "No owner/manager phone numbers" }, 200, corsHeaders);
        }

        const propName = typeof property.name === "string" && property.name ? property.name : "Your PG";
        const params = [tenantName, propName, roomNumber, amount, month];
        const messageText = `💳 *${propName} — Payment Received*\n\n────────────────────\n👤 *Tenant:* ${tenantName}\n🚪 *Room:* ${roomNumber}\n💰 *Amount:* ₹${amount}\n📅 *Month:* ${month}\n\nPayment proof submitted. Please review & approve on the dashboard.\n────────────────────\n_Sent via PG Buddy_`;

        let sent = 0;
        for (const r of recipients) {
          const viaCloud = {
            def: TEMPLATES.paymentProofSubmitted,
            values: [propName, tenantName, roomNumber, formatIndianNumber(Number(amount) || 0), formatPeriod(month) || month],
          };
          if (await sendCloudFirst(r.phone, viaCloud, providerCfg, fetchFn, () =>
            sendSingleWhatsApp(r.phone, "payment_approval", params, messageText, providerCfg, fetchFn))) {
            sent++;
          }
        }

        return jsonResponse({ sent, total: recipients.length }, 200, corsHeaders);
      }

      if (action === "send-payment-received") {
        const tenantPhone = asStr(payload.tenant_phone).trim();
        if (!tenantPhone) {
          return jsonResponse({ sent: 0, message: "No tenant phone number provided" }, 200, corsHeaders);
        }

        const tenantName = asStr(payload.tenant_name, "Tenant");
        const amount = asStr(payload.amount, "0");
        const month = asStr(payload.month, "this month");
        const propertyName = asStr(payload.property_name, "Your PG");
        const roomNumber = asStr(payload.room_number, "N/A");
        const receiptUrl = asStr(payload.receipt_url);

        let finalUrl = receiptUrl || appUrl;
        if (
          finalUrl.includes("localhost") ||
          finalUrl.includes("192.168.") ||
          finalUrl.includes("127.0.0.1") ||
          finalUrl.includes("10.0.")
        ) {
          const urlParts = finalUrl.split("/receipt/");
          finalUrl = urlParts.length > 1
            ? `${appUrl}/receipt/${urlParts[1]}`
            : appUrl;
        }

        const params = [tenantName, amount, month, propertyName, roomNumber, finalUrl];
        const messageText = `💰 *Payment Received*\n\nHi ${tenantName},\nWe have received your payment of ₹${amount} for ${month}.\n\nView receipt: ${finalUrl}\n\n_PG Buddy App_`;

        const ok = await sendSingleWhatsApp(
          tenantPhone,
          "payment_received",
          params,
          messageText,
          providerCfg,
          fetchFn,
        );

        return jsonResponse({ sent: ok ? 1 : 0, total: 1 }, 200, corsHeaders);
      }

      const memberPhone = asStr(payload.member_phone).trim();
      if (!memberPhone) {
        return jsonResponse({ sent: 0, message: "No phone number provided" }, 200, corsHeaders);
      }

      const memberName = asStr(payload.member_name, "Member");
      const amount = asStr(payload.amount, "0");
      const month = asStr(payload.month, "this month");
      const messName = asStr(payload.mess_name, "Your PG Buddy Host");

      const params = [memberName, amount, month, messName];
      const messageText = `🍲 *Mess Bill Reminder*\n\nHi ${memberName},\nThis is a reminder for your mess bill of ₹${amount} for ${month} at ${messName}.\n\n_PG Buddy App_`;

      const ok = await sendCloudFirst(
        memberPhone,
        {
          def: TEMPLATES.messBillReminder,
          values: [memberName, formatIndianNumber(Number(amount) || 0), formatPeriod(month) || month, messName],
        },
        providerCfg,
        fetchFn,
        () => sendSingleWhatsApp(memberPhone, "announcement", params, messageText, providerCfg, fetchFn),
      );

      return jsonResponse({ sent: ok ? 1 : 0, total: 1 }, 200, corsHeaders);
    } catch (err) {
      if (err instanceof ConfigError) {
        return jsonResponse({ error: err.message }, err.status, corsHeaders);
      }
      console.error("Unexpected twilio-notifications error:", err);
      return jsonResponse({ error: "Notification dispatch failed" }, 500, corsHeaders);
    }
  };
}
