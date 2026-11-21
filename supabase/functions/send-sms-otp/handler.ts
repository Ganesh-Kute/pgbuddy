import {
  ConfigError,
  type EnvGetter,
  OtpRateLimiter,
  defaultGetEnv,
  extractBearerToken,
  getClientIp,
  handleCorsAndOrigin,
  jsonResponse,
  maskPhone,
  normalizeIndianPhone10,
  requireEnv,
  requireSecretEnv,
  timingSafeEqualStr,
  verifyStandardWebhookSignature,
} from "../_shared/security.ts";

export interface SendSmsOtpDeps {
  fetchFn?: typeof fetch;
  getEnv?: EnvGetter;
  rateLimiter?: OtpRateLimiter;
  nowFn?: () => number;
}

interface OtpHookPayload {
  user?: { phone?: unknown };
  sms?: { otp?: unknown };
  record?: { phone?: unknown };
  phone?: unknown;
  token?: unknown;
  otp?: unknown;
}

const defaultRateLimiter = new OtpRateLimiter();

async function authorizeHookRequest(
  req: Request,
  rawBody: string,
  getEnv: EnvGetter,
  nowMs: number,
): Promise<{ ok: boolean; status?: 401 | 500; error?: string }> {
  const sendSmsHookSecret = getEnv("SEND_SMS_HOOK_SECRET")?.trim() || "";
  const cronSecret = getEnv("CRON_SECRET")?.trim() || "";
  const serviceRoleKey = getEnv("SUPABASE_SERVICE_ROLE_KEY")?.trim() || "";

  if (!sendSmsHookSecret && !cronSecret && !serviceRoleKey) {
    return {
      ok: false,
      status: 500,
      error: "Server configuration error: SEND_SMS_HOOK_SECRET or CRON_SECRET is not configured",
    };
  }

  const bearer = extractBearerToken(req) || "";
  const cronHeader = req.headers.get("x-cron-secret")?.trim() || "";
  const hookHeader = req.headers.get("x-hook-secret")?.trim() || "";

  if (serviceRoleKey && bearer && timingSafeEqualStr(serviceRoleKey, bearer)) {
    return { ok: true };
  }
  if (cronSecret && ((cronHeader && timingSafeEqualStr(cronSecret, cronHeader)) || (bearer && timingSafeEqualStr(cronSecret, bearer)))) {
    return { ok: true };
  }
  if (sendSmsHookSecret && hookHeader && timingSafeEqualStr(sendSmsHookSecret, hookHeader)) {
    return { ok: true };
  }

  if (sendSmsHookSecret && req.headers.has("webhook-signature")) {
    const check = await verifyStandardWebhookSignature(
      rawBody,
      req.headers,
      sendSmsHookSecret,
      Math.floor(nowMs / 1000),
    );
    if (check.ok) {
      return { ok: true };
    }
    return { ok: false, status: 401, error: check.reason || "Unauthorized webhook signature" };
  }

  if (!sendSmsHookSecret && !cronSecret) {
    return {
      ok: false,
      status: 500,
      error: "Server configuration error: SEND_SMS_HOOK_SECRET or CRON_SECRET is not configured",
    };
  }

  return { ok: false, status: 401, error: "Unauthorized" };
}

export function createSendSmsOtpHandler({
  fetchFn = fetch,
  getEnv = defaultGetEnv,
  rateLimiter = defaultRateLimiter,
  nowFn = () => Date.now(),
}: SendSmsOtpDeps = {}) {
  return async (req: Request): Promise<Response> => {
    const { corsHeaders, response: corsResp } = handleCorsAndOrigin(
      req,
      ["x-cron-secret", "x-hook-secret", "webhook-id", "webhook-timestamp", "webhook-signature"],
      getEnv,
    );
    if (corsResp) return corsResp;

    if (req.method !== "POST") {
      return jsonResponse({ error: "Method not allowed" }, 405, corsHeaders);
    }

    try {
      const waServerUrl = requireEnv("WA_SERVER_URL", getEnv).replace(/\/+$/, "");
      const waServerSecret = requireSecretEnv("WA_SERVER_SECRET", getEnv);

      const rawBody = await req.text();
      const nowMs = nowFn();
      const auth = await authorizeHookRequest(req, rawBody, getEnv, nowMs);
      if (!auth.ok) {
        return jsonResponse({ error: auth.error || "Unauthorized" }, auth.status || 401, corsHeaders);
      }

      let payload: OtpHookPayload;
      try {
        payload = JSON.parse(rawBody) as OtpHookPayload;
      } catch {
        return jsonResponse({ error: "Invalid JSON payload" }, 400, corsHeaders);
      }

      const rawPhone = payload.user?.phone ?? payload.phone ?? payload.record?.phone;
      const rawOtp = payload.sms?.otp ?? payload.token ?? payload.otp;

      const phoneStr = typeof rawPhone === "string" || typeof rawPhone === "number" ? String(rawPhone) : "";
      const otpStr = typeof rawOtp === "string" || typeof rawOtp === "number" ? String(rawOtp).trim() : "";

      const phone10 = normalizeIndianPhone10(phoneStr);
      if (!phone10 || !otpStr) {
        return jsonResponse({ error: "Valid phone and otp are required" }, 400, corsHeaders);
      }

      const clientIp = getClientIp(req);
      const limit = rateLimiter.checkAndConsume(phone10, clientIp, nowMs);
      if (!limit.allowed) {
        return jsonResponse(
          { error: limit.reason || "Rate limit exceeded", retryAfterSeconds: limit.retryAfterSeconds },
          429,
          corsHeaders,
          { "Retry-After": String(limit.retryAfterSeconds) },
        );
      }

      const parsedPhone = `91${phone10}`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);

      try {
        const resp = await fetchFn(`${waServerUrl}/api/send-otp`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-server-secret": waServerSecret,
            "Bypass-Tunnel-Reminder": "true",
          },
          body: JSON.stringify({ phoneNumber: parsedPhone, otp: otpStr }),
          signal: controller.signal,
        });

        clearTimeout(timeout);
        const rawText = await resp.text();

        if (!resp.ok) {
          console.error(`WA server OTP failed for ${maskPhone(phone10)} with HTTP ${resp.status}`);
          return jsonResponse({ error: "Failed to deliver OTP via WhatsApp server" }, 502, corsHeaders);
        }

        let data: { success?: boolean } = {};
        try {
          data = JSON.parse(rawText) as { success?: boolean };
        } catch {
          console.warn(`[WA Server] Non-JSON 2xx response for ${maskPhone(phone10)} (likely tunnel proxy)`);
          return jsonResponse({ success: true, message: "OTP sent (tunnel response garbled)" }, 200, corsHeaders);
        }

        if (data.success === false) {
          return jsonResponse({ error: "WhatsApp server rejected OTP delivery" }, 502, corsHeaders);
        }

        console.log(`OTP sent to ${maskPhone(phone10)}`);
        return jsonResponse({ success: true, message: "OTP sent via WhatsApp" }, 200, corsHeaders);
      } catch (fetchErr: unknown) {
        clearTimeout(timeout);
        const msg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
        console.error(`WA server network error for ${maskPhone(phone10)}: ${msg}`);
        return jsonResponse({ error: "WhatsApp OTP server unreachable" }, 502, corsHeaders);
      }
    } catch (error) {
      if (error instanceof ConfigError) {
        return jsonResponse({ error: error.message }, error.status, corsHeaders);
      }
      console.error("SMS Edge error:", error instanceof Error ? error.message : String(error));
      return jsonResponse({ error: "OTP delivery error" }, 500, corsHeaders);
    }
  };
}
