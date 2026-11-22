// Meta's official WhatsApp Cloud API (graph.facebook.com), used before the self-hosted WhatsApp server.
//
// Business-initiated messages must use a template Meta has approved. PG Buddy's templates live on the
// "PG-Buddy" WhatsApp Business Account (number +91 95455 54067):
//   payment_receipt  UTILITY  header DOCUMENT, body {{1}} name, {{2}} amount, {{3}} period, {{4}} PG
//   rent_reminder    UTILITY  body {{1}} name, {{2}} amount, {{3}} period, {{4}} PG, {{5}} due date
// Until a template is approved Meta refuses the send, and the caller falls back to the next provider.
//
// Secrets: WHATSAPP_TOKEN (permanent system-user token), WHATSAPP_PHONE_NUMBER_ID.

export const GRAPH_VERSION = "v25.0";
const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;
const TIMEOUT_MS = 15_000;

export type CloudConfig = { token: string; phoneNumberId: string };

/** ok, or why not (one flat shape: the app's tsconfig does not narrow unions on `ok`). */
export type CloudSendResult = {
  ok: boolean;
  messageId?: string | null;
  reason?: "not_on_whatsapp" | "template_not_ready" | "failed";
  detail?: string;
};

type Env = (name: string) => string | undefined;

/** The Cloud API settings, or null when they are not set up (then the other providers are used). */
export function cloudConfigFromEnv(getEnv: Env): CloudConfig | null {
  const token = getEnv("WHATSAPP_TOKEN")?.trim();
  const phoneNumberId = getEnv("WHATSAPP_PHONE_NUMBER_ID")?.trim();
  if (!token || !phoneNumberId || !/^\d{5,20}$/.test(phoneNumberId)) return null;
  return { token, phoneNumberId };
}

/** "9876543210" or "+91 98765 43210" -> "919876543210" (Cloud API wants country code, digits only). */
export function toWaId(phone: string): string | null {
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 10) return `91${digits}`;
  if (digits.length === 12 && digits.startsWith("91")) return digits;
  return null;
}

/** Template text parameters may not contain newlines, tabs or 4+ spaces in a row, and are capped. */
export function templateText(value: string, max = 200): string {
  const v = value.replace(/[\r\n\t]+/g, " ").replace(/ {4,}/g, "   ").trim();
  return (v || "-").slice(0, max);
}

// Error codes from https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes
const NOT_ON_WHATSAPP = new Set([131026]);
const TEMPLATE_NOT_READY = new Set([132000, 132001, 132005, 132007, 132012, 132015, 132016]);

function classifyError(body: unknown): CloudSendResult {
  const err = (body as { error?: { code?: number; message?: string; error_data?: { details?: string } } })?.error;
  const code = err?.code ?? 0;
  const detail = `${code} ${err?.message ?? ""} ${err?.error_data?.details ?? ""}`.trim().slice(0, 200);
  if (NOT_ON_WHATSAPP.has(code)) return { ok: false, reason: "not_on_whatsapp", detail };
  if (TEMPLATE_NOT_READY.has(code)) return { ok: false, reason: "template_not_ready", detail };
  return { ok: false, reason: "failed", detail };
}

async function graphFetch(fetchFn: typeof fetch, url: string, init: RequestInit): Promise<{ ok: boolean; body: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const resp = await fetchFn(url, { ...init, signal: controller.signal });
    let body: unknown = null;
    try {
      body = await resp.json();
    } catch {
      body = null;
    }
    return { ok: resp.ok, body };
  } finally {
    clearTimeout(timer);
  }
}

/** Upload a file to WhatsApp's media store (kept by Meta for 30 days; nothing is stored in Supabase). */
export async function uploadMedia(
  cfg: CloudConfig,
  bytes: Uint8Array,
  filename: string,
  mimeType: string,
  fetchFn: typeof fetch,
): Promise<string | null> {
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("type", mimeType);
  form.append("file", new Blob([bytes], { type: mimeType }), filename);
  try {
    const { ok, body } = await graphFetch(fetchFn, `${GRAPH}/${cfg.phoneNumberId}/media`, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.token}` },
      body: form,
    });
    const id = (body as { id?: unknown })?.id;
    if (ok && typeof id === "string") return id;
    console.warn("[WA Cloud] media upload refused:", classifyError(body));
    return null;
  } catch (err) {
    console.warn("[WA Cloud] media upload error:", err instanceof Error ? err.message : String(err));
    return null;
  }
}

export async function sendTemplate(
  cfg: CloudConfig,
  to: string,
  name: string,
  components: unknown[],
  fetchFn: typeof fetch,
  language = "en",
): Promise<CloudSendResult> {
  const waId = toWaId(to);
  if (!waId) return { ok: false, reason: "failed", detail: "bad phone number" };
  try {
    const { ok, body } = await graphFetch(fetchFn, `${GRAPH}/${cfg.phoneNumberId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: waId,
        type: "template",
        template: { name, language: { code: language }, components },
      }),
    });
    if (ok) {
      const id = (body as { messages?: { id?: string }[] })?.messages?.[0]?.id ?? null;
      return { ok: true, messageId: id };
    }
    return classifyError(body);
  } catch (err) {
    return { ok: false, reason: "failed", detail: err instanceof Error ? err.message : String(err) };
  }
}

const bodyParams = (values: string[]) => ({
  type: "body",
  parameters: values.map((v) => ({ type: "text", text: templateText(v) })),
});

/** The receipt PDF as a document message using the approved payment_receipt template. */
export async function sendReceiptDocument(
  cfg: CloudConfig,
  to: string,
  pdf: Uint8Array,
  filename: string,
  values: { tenantName: string; amount: string; period: string; propertyName: string },
  fetchFn: typeof fetch,
): Promise<CloudSendResult> {
  const mediaId = await uploadMedia(cfg, pdf, filename, "application/pdf", fetchFn);
  if (!mediaId) return { ok: false, reason: "failed", detail: "media upload failed" };
  return sendTemplate(
    cfg,
    to,
    "payment_receipt",
    [
      { type: "header", parameters: [{ type: "document", document: { id: mediaId, filename } }] },
      bodyParams([values.tenantName, values.amount, values.period, values.propertyName]),
    ],
    fetchFn,
  );
}

export function sendRentReminder(
  cfg: CloudConfig,
  to: string,
  values: { tenantName: string; amount: string; period: string; propertyName: string; dueDate: string },
  fetchFn: typeof fetch,
): Promise<CloudSendResult> {
  return sendTemplate(
    cfg,
    to,
    "rent_reminder",
    [bodyParams([values.tenantName, values.amount, values.period, values.propertyName, values.dueDate])],
    fetchFn,
  );
}
