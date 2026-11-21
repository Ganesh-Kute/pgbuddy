export type EnvGetter = (name: string) => string | undefined;

export const COMPROMISED_DEFAULT_WA_SECRET = "pg_buddy_whatsapp_secret_2024";

export class ConfigError extends Error {
  readonly status = 500;
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export const defaultGetEnv: EnvGetter = (name: string): string | undefined => {
  const denoEnv = (globalThis as { Deno?: { env?: { get(key: string): string | undefined } } }).Deno?.env;
  if (denoEnv && typeof denoEnv.get === "function") {
    return denoEnv.get(name);
  }
  const nodeEnv = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  return nodeEnv?.[name];
};

export function requireEnv(name: string, getEnv: EnvGetter = defaultGetEnv): string {
  const val = getEnv(name)?.trim();
  if (!val) {
    throw new ConfigError(`Server configuration error: ${name} is not configured`);
  }
  return val;
}

export function requireSecretEnv(
  name: string,
  getEnv: EnvGetter = defaultGetEnv,
  disallowed: readonly string[] = [COMPROMISED_DEFAULT_WA_SECRET],
): string {
  const val = requireEnv(name, getEnv);
  if (disallowed.includes(val)) {
    throw new ConfigError(`Server configuration error: ${name} must not use a hardcoded default secret`);
  }
  return val;
}

export const DEFAULT_ALLOWED_ORIGINS: readonly string[] = [
  "https://pgbuddy.lovable.app",
  "https://pgbuddy-zeta-rust.vercel.app",
  "https://pgbuddy.in",
  "https://www.pgbuddy.in",
  "https://localhost",
  "capacitor://localhost",
  "ionic://localhost",
];

function normalizeOrigin(origin: string): string | null {
  const trimmed = origin.trim();
  if (!trimmed || trimmed === "*" || trimmed.toLowerCase() === "null") {
    return null;
  }
  const lower = trimmed.toLowerCase();
  if (lower === "capacitor://localhost" || lower === "ionic://localhost") {
    return lower;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return `${parsed.protocol}//${parsed.host.toLowerCase()}`;
  } catch {
    return null;
  }
}

export function isAllowedOrigin(origin: string, getEnv: EnvGetter = defaultGetEnv): boolean {
  const normalized = normalizeOrigin(origin);
  if (!normalized) return false;

  if (DEFAULT_ALLOWED_ORIGINS.includes(normalized)) {
    return true;
  }

  // Allow local web development & Capacitor localhost ports
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(normalized)) {
    return true;
  }

  const extraRaw = getEnv("ALLOWED_ORIGINS") || "";
  for (const entry of extraRaw.split(",")) {
    const allowedExtra = normalizeOrigin(entry);
    if (allowedExtra && allowedExtra === normalized) {
      return true;
    }
  }
  return false;
}

const BASE_ALLOW_HEADERS = [
  "authorization",
  "x-client-info",
  "apikey",
  "content-type",
  "x-supabase-client-platform",
  "x-supabase-client-platform-version",
  "x-supabase-client-runtime",
  "x-supabase-client-runtime-version",
  "origin",
  "accept",
  "x-requested-with",
];

export interface CorsResult {
  allowed: boolean;
  origin: string | null;
  headers: Record<string, string>;
}

export function buildCorsContext(
  req: Request,
  extraAllowHeaders: readonly string[] = [],
  getEnv: EnvGetter = defaultGetEnv,
): CorsResult {
  const origin = req.headers.get("origin");
  if (!origin) {
    return {
      allowed: true,
      origin: null,
      headers: { Vary: "Origin" },
    };
  }

  if (!isAllowedOrigin(origin, getEnv)) {
    return {
      allowed: false,
      origin,
      headers: { Vary: "Origin" },
    };
  }

  const allowHeaders = Array.from(new Set([...BASE_ALLOW_HEADERS, ...extraAllowHeaders])).join(", ");
  return {
    allowed: true,
    origin,
    headers: {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Headers": allowHeaders,
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      Vary: "Origin",
    },
  };
}

export function jsonResponse(
  body: unknown,
  status: number,
  corsHeaders: Record<string, string>,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      ...extraHeaders,
      "Content-Type": "application/json",
    },
  });
}

export function handleCorsAndOrigin(
  req: Request,
  extraAllowHeaders: readonly string[] = [],
  getEnv: EnvGetter = defaultGetEnv,
): { corsHeaders: Record<string, string>; response: Response | null } {
  const cors = buildCorsContext(req, extraAllowHeaders, getEnv);
  if (!cors.allowed) {
    return {
      corsHeaders: cors.headers,
      response: jsonResponse({ error: "Origin not allowed" }, 403, cors.headers),
    };
  }
  if (req.method === "OPTIONS") {
    return {
      corsHeaders: cors.headers,
      response: new Response(null, { status: 204, headers: cors.headers }),
    };
  }
  return { corsHeaders: cors.headers, response: null };
}

export function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length === 0 || b.length === 0) {
    return false;
  }
  const maxLen = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < maxLen; i++) {
    diff |= a[i % a.length] ^ b[i % b.length];
  }
  return diff === 0;
}

export function timingSafeEqualStr(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  return timingSafeEqualBytes(encoder.encode(a), encoder.encode(b));
}

async function importHmacKey(rawKey: Uint8Array): Promise<CryptoKey> {
  const keyBytes = new Uint8Array(rawKey);
  return crypto.subtle.importKey(
    "raw",
    keyBytes.buffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await importHmacKey(encoder.encode(secret));
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function hmacSha256Base64(secretBytes: Uint8Array, message: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await importHmacKey(secretBytes);
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  let binary = "";
  const bytes = new Uint8Array(sig);
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export async function verifyRazorpayWebhookSignature(
  rawBody: string,
  signatureHeader: string | null,
  secret: string,
): Promise<boolean> {
  if (!signatureHeader || !secret) return false;
  const provided = signatureHeader.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(provided)) return false;
  const expected = await hmacSha256Hex(secret, rawBody);
  return timingSafeEqualStr(expected, provided);
}

export async function verifyRazorpayCheckoutSignature(
  paymentId: string,
  subscriptionId: string,
  signatureHeader: string,
  secret: string,
): Promise<boolean> {
  if (!paymentId || !subscriptionId || !signatureHeader || !secret) return false;
  const provided = signatureHeader.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(provided)) return false;
  const expected = await hmacSha256Hex(secret, `${paymentId}|${subscriptionId}`);
  return timingSafeEqualStr(expected, provided);
}

function decodeStandardWebhookSecret(secret: string): Uint8Array {
  let clean = secret.trim();
  if (clean.startsWith("v1,")) {
    clean = clean.slice(3);
  }
  if (clean.startsWith("whsec_")) {
    const b64 = clean.slice(6);
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) {
      bytes[i] = bin.charCodeAt(i);
    }
    return bytes;
  }
  return new TextEncoder().encode(clean);
}

export async function verifyStandardWebhookSignature(
  rawBody: string,
  headers: Headers,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
  maxSkewSeconds: number = 300,
): Promise<{ ok: boolean; reason?: string }> {
  const msgId = headers.get("webhook-id")?.trim();
  const msgTs = headers.get("webhook-timestamp")?.trim();
  const msgSig = headers.get("webhook-signature")?.trim();

  if (!msgId || !msgTs || !msgSig) {
    return { ok: false, reason: "Missing webhook signature headers" };
  }

  const tsNum = Number(msgTs);
  if (!Number.isFinite(tsNum)) {
    return { ok: false, reason: "Invalid webhook timestamp" };
  }
  if (Math.abs(nowSeconds - tsNum) > maxSkewSeconds) {
    return { ok: false, reason: "Webhook timestamp outside replay window" };
  }

  let secretBytes: Uint8Array;
  try {
    secretBytes = decodeStandardWebhookSecret(secret);
  } catch {
    return { ok: false, reason: "Invalid webhook secret encoding" };
  }
  if (secretBytes.length === 0) {
    return { ok: false, reason: "Empty webhook secret" };
  }

  const expectedB64 = await hmacSha256Base64(secretBytes, `${msgId}.${msgTs}.${rawBody}`);
  const candidates = msgSig.split(/\s+/);
  for (const token of candidates) {
    const commaIdx = token.indexOf(",");
    if (commaIdx === -1) continue;
    const version = token.slice(0, commaIdx);
    const sigVal = token.slice(commaIdx + 1);
    if (version === "v1" && timingSafeEqualStr(expectedB64, sigVal)) {
      return { ok: true };
    }
  }
  return { ok: false, reason: "Webhook signature mismatch" };
}

export function extractBearerToken(req: Request): string | null {
  const auth = req.headers.get("authorization");
  if (!auth) return null;
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

export interface ServiceAuthResult {
  authorized: boolean;
  mode?: "cron" | "service_role";
  status?: 401 | 500;
  error?: string;
}

export function verifyCronOrServiceAuth(
  req: Request,
  getEnv: EnvGetter = defaultGetEnv,
): ServiceAuthResult {
  const serviceRoleKey = getEnv("SUPABASE_SERVICE_ROLE_KEY")?.trim() || "";
  const cronSecret = getEnv("CRON_SECRET")?.trim() || "";

  const bearer = extractBearerToken(req);
  const cronHeader = req.headers.get("x-cron-secret")?.trim() || "";

  if (serviceRoleKey && bearer && timingSafeEqualStr(serviceRoleKey, bearer)) {
    return { authorized: true, mode: "service_role" };
  }

  if (cronSecret) {
    if (cronHeader && timingSafeEqualStr(cronSecret, cronHeader)) {
      return { authorized: true, mode: "cron" };
    }
    if (bearer && timingSafeEqualStr(cronSecret, bearer)) {
      return { authorized: true, mode: "cron" };
    }
    return { authorized: false, status: 401, error: "Unauthorized: invalid or missing cron/service credentials" };
  }

  return {
    authorized: false,
    status: 500,
    error: "Server configuration error: CRON_SECRET is not configured",
  };
}

export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.trim());
}

export function normalizeIndianPhone10(phone: string): string | null {
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 10 || digits.length > 15) return null;
  return digits.slice(-10);
}

export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length <= 4) return "****";
  return `******${digits.slice(-4)}`;
}

export function getClientIp(req: Request): string {
  const cfIp = req.headers.get("cf-connecting-ip")?.trim();
  if (cfIp) return cfIp;
  const realIp = req.headers.get("x-real-ip")?.trim();
  if (realIp) return realIp;
  const fwd = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (fwd) return fwd;
  return "unknown";
}

export interface RateLimitDecision {
  allowed: boolean;
  retryAfterSeconds: number;
  reason?: string;
}

export interface OtpRateLimiterOptions {
  phoneCooldownMs?: number;
  phoneWindowMs?: number;
  phoneMaxRequests?: number;
  ipWindowMs?: number;
  ipMaxRequests?: number;
  maxEntries?: number;
}

export class OtpRateLimiter {
  private readonly phoneTimestamps = new Map<string, number[]>();
  private readonly ipTimestamps = new Map<string, number[]>();
  private readonly phoneCooldownMs: number;
  private readonly phoneWindowMs: number;
  private readonly phoneMaxRequests: number;
  private readonly ipWindowMs: number;
  private readonly ipMaxRequests: number;
  private readonly maxEntries: number;

  constructor(options: OtpRateLimiterOptions = {}) {
    this.phoneCooldownMs = options.phoneCooldownMs ?? 30_000;
    this.phoneWindowMs = options.phoneWindowMs ?? 15 * 60_000;
    this.phoneMaxRequests = options.phoneMaxRequests ?? 5;
    this.ipWindowMs = options.ipWindowMs ?? 15 * 60_000;
    this.ipMaxRequests = options.ipMaxRequests ?? 20;
    this.maxEntries = options.maxEntries ?? 1000;
  }

  private pruneMap(map: Map<string, number[]>, windowMs: number, now: number): void {
    if (map.size <= this.maxEntries) return;
    for (const [k, list] of map.entries()) {
      const fresh = list.filter((ts) => now - ts < windowMs);
      if (fresh.length === 0) map.delete(k);
      else map.set(k, fresh);
    }
  }

  checkAndConsume(phoneKey: string, ipKey: string, now: number = Date.now()): RateLimitDecision {
    this.pruneMap(this.phoneTimestamps, this.phoneWindowMs, now);
    this.pruneMap(this.ipTimestamps, this.ipWindowMs, now);

    const recentPhone = (this.phoneTimestamps.get(phoneKey) || []).filter(
      (ts) => now - ts < this.phoneWindowMs,
    );
    const lastPhoneTs = recentPhone[recentPhone.length - 1];
    if (lastPhoneTs !== undefined && now - lastPhoneTs < this.phoneCooldownMs) {
      const retryAfterSeconds = Math.max(1, Math.ceil((this.phoneCooldownMs - (now - lastPhoneTs)) / 1000));
      return {
        allowed: false,
        retryAfterSeconds,
        reason: `OTP recently sent. Please wait ${retryAfterSeconds}s before retrying.`,
      };
    }

    if (recentPhone.length >= this.phoneMaxRequests) {
      const oldest = recentPhone[0];
      const retryAfterSeconds = Math.max(1, Math.ceil((this.phoneWindowMs - (now - oldest)) / 1000));
      return {
        allowed: false,
        retryAfterSeconds,
        reason: "Too many OTP requests for this phone number.",
      };
    }

    if (ipKey && ipKey !== "unknown") {
      const recentIp = (this.ipTimestamps.get(ipKey) || []).filter((ts) => now - ts < this.ipWindowMs);
      if (recentIp.length >= this.ipMaxRequests) {
        const oldest = recentIp[0];
        const retryAfterSeconds = Math.max(1, Math.ceil((this.ipWindowMs - (now - oldest)) / 1000));
        return {
          allowed: false,
          retryAfterSeconds,
          reason: "Too many OTP requests from this IP address.",
        };
      }
      recentIp.push(now);
      this.ipTimestamps.set(ipKey, recentIp);
    }

    recentPhone.push(now);
    this.phoneTimestamps.set(phoneKey, recentPhone);
    return { allowed: true, retryAfterSeconds: 0 };
  }
}
