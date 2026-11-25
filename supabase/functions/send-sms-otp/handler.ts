// Supabase Auth "Send SMS" hook: delivers the login code on WhatsApp.
//
//   1. Meta's official Cloud API with the approved login_otp template (needs no PC or tunnel).
//   2. The self-hosted whatsapp-web.js server (WA_SERVER_URL), if the Cloud API is not set up or fails.
// When neither delivers, the hook returns an error so the app says so, instead of the user waiting
// for a code that never comes.
//
// Only Supabase Auth may call this: the request must carry a valid Standard Webhooks signature made
// with SEND_SMS_HOOK_SECRET (the same "v1,whsec_..." value as the hook's secret in Auth settings).
// Without that check anyone could send WhatsApp messages from the business number, at our cost.
// The code itself is never logged.

import { COMPROMISED_DEFAULT_WA_SECRET, verifyStandardWebhookSignature } from "../_shared/security.ts";
import { cloudConfigFromEnv, sendLoginOtp } from "../_shared/whatsapp-cloud.ts";

type Env = (name: string) => string | undefined;

export type SendSmsOtpDeps = {
  getEnv: Env;
  fetchFn: typeof fetch;
  /** Seconds since the epoch. */
  nowSeconds?: () => number;
};

const WA_SERVER_TIMEOUT_MS = 15_000;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** The error shape Supabase Auth hooks understand; the message reaches the app. */
const hookError = (status: number, message: string) => json({ error: { http_code: status, message } }, status);

export const maskPhone = (phone: string) => {
  const d = phone.replace(/\D/g, "");
  return d.length >= 4 ? `…${d.slice(-4)}` : "…";
};

type Delivery = { ok: boolean; notOnWhatsApp?: boolean };

async function sendViaWaServer(deps: SendSmsOtpDeps, phone: string, code: string): Promise<Delivery> {
  const url = deps.getEnv("WA_SERVER_URL")?.trim().replace(/\/+$/, "");
  const secret = deps.getEnv("WA_SERVER_SECRET")?.trim();
  if (!url) return { ok: false };
  if (!secret || secret === COMPROMISED_DEFAULT_WA_SECRET) {
    console.error("[send-sms-otp] WA_SERVER_SECRET is missing or the old default: not using the WhatsApp server");
    return { ok: false };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WA_SERVER_TIMEOUT_MS);
  try {
    const resp = await deps.fetchFn(`${url}/api/send-otp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-server-secret": secret, "Bypass-Tunnel-Reminder": "true" },
      body: JSON.stringify({ phoneNumber: "91" + phone.replace(/\D/g, "").slice(-10), otp: code }),
      signal: controller.signal,
    });
    const text = await resp.text();
    let data: { success?: boolean } | null = null;
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
    if (resp.ok && data?.success) return { ok: true };
    console.warn(`[send-sms-otp] WhatsApp server refused (HTTP ${resp.status}) for ${maskPhone(phone)}`);
    return { ok: false };
  } catch (err) {
    console.warn(`[send-sms-otp] WhatsApp server unreachable: ${err instanceof Error ? err.message : String(err)}`);
    return { ok: false };
  } finally {
    clearTimeout(timer);
  }
}

export function createSendSmsOtpHandler(deps: SendSmsOtpDeps) {
  const now = deps.nowSeconds ?? (() => Math.floor(Date.now() / 1000));

  return async (req: Request): Promise<Response> => {
    if (req.method !== "POST") return hookError(405, "Method not allowed");

    const secret = deps.getEnv("SEND_SMS_HOOK_SECRET")?.trim();
    if (!secret) {
      console.error("[send-sms-otp] SEND_SMS_HOOK_SECRET is not set");
      return hookError(500, "Login codes are not available right now. Please try again later.");
    }

    const body = await req.text();
    const signature = await verifyStandardWebhookSignature(body, req.headers, secret, now());
    if (!signature.ok) {
      console.warn(`[send-sms-otp] rejected: ${signature.reason}`);
      return hookError(401, "Invalid signature");
    }

    let payload: { user?: { phone?: unknown }; sms?: { otp?: unknown } };
    try {
      payload = JSON.parse(body);
    } catch {
      return hookError(400, "Invalid request");
    }
    const phone = typeof payload?.user?.phone === "string" ? payload.user.phone : "";
    const code = typeof payload?.sms?.otp === "string" ? payload.sms.otp : String(payload?.sms?.otp ?? "");
    if (!phone || !/^\d{4,10}$/.test(code)) return hookError(400, "Invalid request");

    // 1. Official API.
    const cloud = cloudConfigFromEnv(deps.getEnv);
    if (cloud) {
      const res = await sendLoginOtp(cloud, phone, code, deps.fetchFn);
      if (res.ok) {
        console.log(`[send-sms-otp] sent via Cloud API to ${maskPhone(phone)}`);
        return json({});
      }
      if (res.reason === "not_on_whatsapp") {
        return hookError(400, "This number is not on WhatsApp. Please use a number that has WhatsApp.");
      }
      console.warn(`[send-sms-otp] Cloud API failed (${res.reason}): ${res.detail ?? ""}`);
    }

    // 2. Self-hosted WhatsApp server.
    const viaServer = await sendViaWaServer(deps, phone, code);
    if (viaServer.ok) {
      console.log(`[send-sms-otp] sent via WhatsApp server to ${maskPhone(phone)}`);
      return json({});
    }

    return hookError(500, "Could not send the code on WhatsApp. Please try again in a minute.");
  };
}
