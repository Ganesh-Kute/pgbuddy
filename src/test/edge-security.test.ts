// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import type http from "node:http";
import { describe, expect, it, vi } from "vitest";

import {
  COMPROMISED_DEFAULT_WA_SECRET,
  OtpRateLimiter,
  buildCorsContext,
  hmacSha256Hex,
  isAllowedOrigin,
  timingSafeEqualStr,
  verifyCronOrServiceAuth,
  verifyStandardWebhookSignature,
} from "../../supabase/functions/_shared/security.ts";
import { createGetReceiptHandler } from "../../supabase/functions/get-receipt/handler.ts";
import { createRazorpayWebhookHandler } from "../../supabase/functions/razorpay-webhook/handler.ts";
import { createCreateSubscriptionHandler } from "../../supabase/functions/create-subscription/handler.ts";
import { createVerifySubscriptionHandler } from "../../supabase/functions/verify-subscription-payment/handler.ts";
import { createPushNotificationsHandler } from "../../supabase/functions/push-notifications/handler.ts";
import { createRentRemindersHandler, type RentQueryChain } from "../../supabase/functions/rent-reminders/handler.ts";
import { createSendSmsOtpHandler } from "../../supabase/functions/send-sms-otp/handler.ts";
import { createTwilioNotificationsHandler } from "../../supabase/functions/twilio-notifications/handler.ts";

const ROOT = path.resolve(__dirname, "../..");
const require = createRequire(import.meta.url);

function makeEnv(overrides: Record<string, string | undefined> = {}) {
  const base: Record<string, string | undefined> = {
    SUPABASE_URL: "https://vcpohetbsyyjqqkzuzxj.supabase.co",
    SUPABASE_ANON_KEY: "anon-jwt-key",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-secret-key",
    CRON_SECRET: "cron-secret-123456",
    RAZORPAY_KEY_ID: "rzp_test_123",
    RAZORPAY_KEY_SECRET: "rzp_secret_123456",
    VAPID_PUBLIC_KEY: "vapid-pub-123",
    VAPID_PRIVATE_KEY: "vapid-priv-123",
    WA_SERVER_URL: "https://wa.pgbuddy.example",
    WA_SERVER_SECRET: "super-strong-wa-secret-999",
    SEND_SMS_HOOK_SECRET: "v1,whsec_" + Buffer.from("hook-hmac-secret-32-bytes-minimum").toString("base64"),
    ...overrides,
  };
  return (name: string) => base[name];
}

function getTomlSection(toml: string, sectionHeader: string): string {
  const idx = toml.indexOf(sectionHeader);
  if (idx === -1) return "";
  const rest = toml.slice(idx + sectionHeader.length);
  const nextSection = rest.search(/^\s*\[/m);
  return nextSection === -1 ? rest : rest.slice(0, nextSection);
}

describe("Track B static & config security invariants", () => {
  it("S5: no edge function or whatsapp-server file contains the leaked fallback secret", () => {
    const targets = [
      "supabase/functions/send-sms-otp/index.ts",
      "supabase/functions/send-sms-otp/handler.ts",
      "supabase/functions/twilio-notifications/index.ts",
      "supabase/functions/twilio-notifications/handler.ts",
      "whatsapp-server/server.js",
      "whatsapp-server/campaign-worker.js",
      "whatsapp-server/.env.example",
    ];
    for (const rel of targets) {
      const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
      expect(src, rel).not.toContain("pg_buddy_whatsapp_secret_2024");
    }
  });

  it("S8: no edge function sets wildcard Access-Control-Allow-Origin: * or uses !== on signatures", () => {
    const fnDirs = fs
      .readdirSync(path.join(ROOT, "supabase/functions"))
      .filter((d) => !d.startsWith("_") && fs.statSync(path.join(ROOT, "supabase/functions", d)).isDirectory());
    for (const dir of fnDirs) {
      const files = fs.readdirSync(path.join(ROOT, "supabase/functions", dir)).filter((f) => f.endsWith(".ts"));
      for (const f of files) {
        const src = fs.readFileSync(path.join(ROOT, "supabase/functions", dir, f), "utf8");
        expect(src, `${dir}/${f}`).not.toMatch(/Access-Control-Allow-Origin["'\s:]+\*/);
      }
    }
    const webhookSrc = fs.readFileSync(path.join(ROOT, "supabase/functions/razorpay-webhook/handler.ts"), "utf8");
    expect(webhookSrc).not.toContain("expectedSig !== signature");
  });

  it("S3: supabase/config.toml enforces verify_jwt = true on push-notifications and twilio-notifications", () => {
    const toml = fs.readFileSync(path.join(ROOT, "supabase/config.toml"), "utf8");
    const pushSec = getTomlSection(toml, "[functions.push-notifications]");
    const twilioSec = getTomlSection(toml, "[functions.twilio-notifications]");
    expect(pushSec).toMatch(/verify_jwt\s*=\s*true/);
    expect(twilioSec).toMatch(/verify_jwt\s*=\s*true/);
  });

  it("S7: get-receipt does not expose owner_phone or query profiles by id instead of user_id", () => {
    const src = fs.readFileSync(path.join(ROOT, "supabase/functions/get-receipt/handler.ts"), "utf8");
    expect(src).not.toContain("owner_phone");
    expect(src).not.toContain('.eq("id", data.tenant_id)');
  });
});

describe("S8: CORS origin allowlist & constant-time comparison", () => {
  it("allows production web, Capacitor mobile, localhost dev, and ALLOWED_ORIGINS, and rejects unknown origins", () => {
    expect(isAllowedOrigin("https://pgbuddy.lovable.app")).toBe(true);
    expect(isAllowedOrigin("https://pgbuddy-zeta-rust.vercel.app")).toBe(true);
    expect(isAllowedOrigin("https://pgbuddy.in")).toBe(true);
    expect(isAllowedOrigin("https://localhost")).toBe(true);
    expect(isAllowedOrigin("capacitor://localhost")).toBe(true);
    expect(isAllowedOrigin("http://localhost:8080")).toBe(true);

    expect(isAllowedOrigin("https://evil-attacker.example.com")).toBe(false);
    expect(isAllowedOrigin("null")).toBe(false);
    expect(isAllowedOrigin("*")).toBe(false);

    const customEnv = makeEnv({ ALLOWED_ORIGINS: "*, https://staging.pgbuddy.in" });
    expect(isAllowedOrigin("https://staging.pgbuddy.in", customEnv)).toBe(true);
    expect(isAllowedOrigin("https://other.example.com", customEnv)).toBe(false);
  });

  it("does not emit wildcard Access-Control-Allow-Origin when Origin is omitted", () => {
    const ctx = buildCorsContext(new Request("https://fn.test", { method: "POST" }));
    expect(ctx.allowed).toBe(true);
    expect(ctx.headers["Access-Control-Allow-Origin"]).toBeUndefined();
  });

  it("timingSafeEqualStr compares full contents and rejects empty or mismatched strings", () => {
    expect(timingSafeEqualStr("secret-abc", "secret-abc")).toBe(true);
    expect(timingSafeEqualStr("secret-abc", "secret-abd")).toBe(false);
    expect(timingSafeEqualStr("secret-abc", "secret-ab")).toBe(false);
    expect(timingSafeEqualStr("", "")).toBe(false);
  });
});

describe("S7: get-receipt edge handler", () => {
  it("rejects disallowed Origin with 403 and invalid UUID with 400", async () => {
    const handler = createGetReceiptHandler({
      createClient: () => {
        throw new Error("should not reach DB");
      },
      getEnv: makeEnv(),
    });

    const badOrigin = await handler(
      new Request("https://fn.test/get-receipt?id=11111111-1111-4111-8111-111111111111", {
        headers: { Origin: "https://evil.example.com" },
      }),
    );
    expect(badOrigin.status).toBe(403);

    const badId = await handler(new Request("https://fn.test/get-receipt?id=not-a-uuid"));
    expect(badId.status).toBe(400);
  });

  it("queries paid receipts only, looks up tenant profile by user_id, and omits owner_phone", async () => {
    const eqCalls: Array<[string, string]> = [];
    const handler = createGetReceiptHandler({
      createClient: () => ({
        from(table: string) {
          return {
            select() {
              return {
                eq(col: string, val: string) {
                  eqCalls.push([`${table}.${col}`, val]);
                  return {
                    eq(col2: string, val2: string) {
                      eqCalls.push([`${table}.${col2}`, val2]);
                      return {
                        async maybeSingle() {
                          return {
                            data: {
                              id: "11111111-1111-4111-8111-111111111111",
                              amount: 8500,
                              month: "2026-11",
                              payment_date: "2026-11-05T10:00:00Z",
                              status: "paid",
                              payment_type: "rent",
                              payment_method: "upi",
                              transaction_id: "TXN123",
                              tenant_name: null,
                              tenant_id: "tenant-user-uuid",
                              property_id: "prop-1",
                              room_id: "room-1",
                            },
                            error: null,
                          };
                        },
                      };
                    },
                    async maybeSingle() {
                      if (table === "properties") {
                        return { data: { name: "Sunshine PG", address: "Pune", owner_id: "owner-1" }, error: null };
                      }
                      if (table === "profiles" && val === "owner-1") {
                        return { data: { full_name: "Ganesh" }, error: null };
                      }
                      if (table === "profiles" && val === "tenant-user-uuid") {
                        return { data: { full_name: "Rahul Sharma" }, error: null };
                      }
                      if (table === "rooms") {
                        return { data: { room_number: "101" }, error: null };
                      }
                      return { data: null, error: null };
                    },
                  };
                },
              };
            },
          };
        },
      }),
      getEnv: makeEnv(),
    });

    const resp = await handler(
      new Request("https://fn.test/get-receipt?id=11111111-1111-4111-8111-111111111111", {
        headers: { Origin: "https://pgbuddy.lovable.app" },
      }),
    );
    expect(resp.status).toBe(200);
    expect(resp.headers.get("Access-Control-Allow-Origin")).toBe("https://pgbuddy.lovable.app");
    const json = await resp.json();
    expect(json.receipt.properties).toEqual({ name: "Sunshine PG", address: "Pune", owner_name: "Ganesh" });
    expect(json.receipt.properties.owner_phone).toBeUndefined();
    expect(json.receipt.profiles).toEqual({ full_name: "Rahul Sharma" });
    expect(eqCalls).toContainEqual(["rent_payments.status", "paid"]);
    expect(eqCalls).toContainEqual(["profiles.user_id", "tenant-user-uuid"]);
  });
});

describe("S8 & payment integrity: razorpay-webhook, create-subscription, verify-subscription-payment", () => {
  it("razorpay-webhook rejects missing/invalid HMAC signatures and accepts valid signatures", async () => {
    let updatedStatus: string | null = null;
    const handler = createRazorpayWebhookHandler({
      createClient: () => ({
        from() {
          return {
            update(vals: Record<string, unknown>) {
              updatedStatus = String(vals.status);
              return {
                async eq() {
                  return { error: null };
                },
              };
            },
          };
        },
      }),
      getEnv: makeEnv(),
    });

    const body = JSON.stringify({
      event: "subscription.activated",
      payload: { subscription: { entity: { id: "sub_123", notes: { billing_cycle: "monthly" } } }, payment: { entity: { id: "pay_1" } } },
    });

    const noSig = await handler(new Request("https://fn.test", { method: "POST", body }));
    expect(noSig.status).toBe(401);

    const badSig = await handler(
      new Request("https://fn.test", {
        method: "POST",
        headers: { "x-razorpay-signature": "0".repeat(64) },
        body,
      }),
    );
    expect(badSig.status).toBe(401);

    const validSig = await hmacSha256Hex("rzp_secret_123456", body);
    const okResp = await handler(
      new Request("https://fn.test", {
        method: "POST",
        headers: { "x-razorpay-signature": validSig },
        body,
      }),
    );
    expect(okResp.status).toBe(200);
    expect(updatedStatus).toBe("active");
  });

  it("verify-subscription-payment requires valid razorpay_signature and matching notes.user_id", async () => {
    const handler = createVerifySubscriptionHandler({
      createClient: () => ({
        auth: {
          async getUser() {
            return { data: { user: { id: "user-A" } }, error: null };
          },
        },
        from() {
          return {
            select() {
              return {
                eq() {
                  return {
                    async single() {
                      return { data: { id: "plan-pro" }, error: null };
                    },
                  };
                },
              };
            },
            async upsert() {
              return { error: null };
            },
          };
        },
      }),
      fetchFn: async () =>
        new Response(
          JSON.stringify({ status: "active", notes: { user_id: "user-B", plan_slug: "pro", billing_cycle: "monthly" } }),
          { status: 200 },
        ),
      getEnv: makeEnv(),
    });

    const badSig = await handler(
      new Request("https://fn.test", {
        method: "POST",
        headers: { Authorization: "Bearer user-jwt" },
        body: JSON.stringify({
          razorpay_payment_id: "pay_1",
          razorpay_subscription_id: "sub_1",
          razorpay_signature: "f".repeat(64),
        }),
      }),
    );
    expect(badSig.status).toBe(401);

    const validSig = await hmacSha256Hex("rzp_secret_123456", "pay_1|sub_1");
    const wrongOwner = await handler(
      new Request("https://fn.test", {
        method: "POST",
        headers: { Authorization: "Bearer user-jwt" },
        body: JSON.stringify({
          razorpay_payment_id: "pay_1",
          razorpay_subscription_id: "sub_1",
          razorpay_signature: validSig,
        }),
      }),
    );
    expect(wrongOwner.status).toBe(403);
  });

  it("create-subscription fails fast when RAZORPAY_KEY_SECRET is missing for paid plans", async () => {
    const handler = createCreateSubscriptionHandler({
      createClient: () => ({
        auth: {
          async getUser() {
            return { data: { user: { id: "user-A" } }, error: null };
          },
        },
        from() {
          return {
            select() {
              return {
                eq() {
                  return {
                    async single() {
                      return {
                        data: { id: "plan-pro", slug: "pro", name: "Pro", monthly_price: 499, yearly_price: 4990 },
                        error: null,
                      };
                    },
                  };
                },
              };
            },
            async upsert() {
              return { error: null };
            },
          };
        },
      }),
      getEnv: makeEnv({ RAZORPAY_KEY_SECRET: undefined }),
    });

    const resp = await handler(
      new Request("https://fn.test", {
        method: "POST",
        headers: { Authorization: "Bearer user-jwt" },
        body: JSON.stringify({ plan_slug: "pro", billing_cycle: "monthly" }),
      }),
    );
    expect(resp.status).toBe(500);
    const json = await resp.json();
    expect(json.error).toContain("RAZORPAY_KEY_SECRET");
  });
});

describe("S3: push-notifications, rent-reminders, send-sms-otp, and twilio-notifications", () => {
  it("push-notifications blocks unauthenticated callers, blocks user JWT on send/other-user subscribe, and allows cron send", async () => {
    const sentPayloads: string[] = [];
    const handler = createPushNotificationsHandler({
      createClient: (_url, key) => ({
        auth: {
          async getUser() {
            return key === "anon-jwt-key"
              ? { data: { user: { id: "user-1" } }, error: null }
              : { data: { user: null }, error: { message: "bad" } };
          },
        },
        from() {
          return {
            select() {
              return {
                async in() {
                  return {
                    data: [{ id: "sub-1", user_id: "user-2", endpoint: "https://push.example/1", p256dh: "p", auth: "a" }],
                    error: null,
                  };
                },
              };
            },
            async upsert() {
              return { error: null };
            },
            delete() {
              return {
                async eq() {
                  return { error: null };
                },
              };
            },
          };
        },
      }),
      sendWebPush: async (_sub, payload) => {
        sentPayloads.push(payload);
      },
      getEnv: makeEnv(),
    });

    const unauth = await handler(new Request("https://fn.test", { method: "POST", body: JSON.stringify({ action: "get-vapid-key" }) }));
    expect(unauth.status).toBe(401);

    const userSend = await handler(
      new Request("https://fn.test", {
        method: "POST",
        headers: { Authorization: "Bearer user-jwt" },
        body: JSON.stringify({ action: "send", target_user_ids: ["user-2"], title: "Hi", message: "Test" }),
      }),
    );
    expect(userSend.status).toBe(403);

    const otherUserSub = await handler(
      new Request("https://fn.test", {
        method: "POST",
        headers: { Authorization: "Bearer user-jwt" },
        body: JSON.stringify({
          action: "subscribe",
          user_id: "user-2",
          subscription: { endpoint: "https://push.example/abc", keys: { p256dh: "p", auth: "a" } },
        }),
      }),
    );
    expect(otherUserSub.status).toBe(403);

    const cronSend = await handler(
      new Request("https://fn.test", {
        method: "POST",
        headers: { "x-cron-secret": "cron-secret-123456" },
        body: JSON.stringify({ action: "send", target_user_ids: ["user-2"], title: "Due", message: "Pay rent" }),
      }),
    );
    expect(cronSend.status).toBe(200);
    expect(sentPayloads).toHaveLength(1);
  });

  it("rent-reminders rejects unauthenticated/anon requests, fails fast when CRON_SECRET unset, and accepts valid CRON_SECRET", async () => {
    const emptyClient = () => ({
      from() {
        return {
          select() {
            const chain: RentQueryChain = {
              eq() {
                return chain;
              },
              gte() {
                return Promise.resolve({ data: [], error: null });
              },
              then<TResult1 = { data: unknown[] | null; error: { message: string } | null }, TResult2 = never>(
                resolve?: ((v: { data: unknown[] | null; error: { message: string } | null }) => TResult1 | PromiseLike<TResult1>) | null,
                reject?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
              ) {
                return Promise.resolve({ data: [] as unknown[], error: null }).then(resolve ?? undefined, reject ?? undefined);
              },
            };
            return chain;
          },
          async insert() {
            return { error: null };
          },
        };
      },
    });

    const unauthHandler = createRentRemindersHandler({ createClient: emptyClient, getEnv: makeEnv() });
    const unauthResp = await unauthHandler(
      new Request("https://fn.test", { method: "POST", headers: { Authorization: "Bearer anon-key" } }),
    );
    expect(unauthResp.status).toBe(401);

    const misconfigHandler = createRentRemindersHandler({
      createClient: emptyClient,
      getEnv: makeEnv({ CRON_SECRET: undefined }),
    });
    const misconfigResp = await misconfigHandler(new Request("https://fn.test", { method: "POST" }));
    expect(misconfigResp.status).toBe(500);

    const okResp = await unauthHandler(
      new Request("https://fn.test", { method: "POST", headers: { "x-cron-secret": "cron-secret-123456" } }),
    );
    expect(okResp.status).toBe(200);
  });

  it("verifyCronOrServiceAuth matches CRON_SECRET and SUPABASE_SERVICE_ROLE_KEY", () => {
    const env = makeEnv();
    expect(
      verifyCronOrServiceAuth(new Request("https://fn.test", { headers: { "x-cron-secret": "cron-secret-123456" } }), env)
        .authorized,
    ).toBe(true);
    expect(
      verifyCronOrServiceAuth(
        new Request("https://fn.test", { headers: { Authorization: "Bearer service-role-secret-key" } }),
        env,
      ).authorized,
    ).toBe(true);
    expect(
      verifyCronOrServiceAuth(new Request("https://fn.test", { headers: { Authorization: "Bearer wrong" } }), env)
        .authorized,
    ).toBe(false);
  });

  it("send-sms-otp verifies Standard Webhooks signature, rejects leaked secret, rate-limits, and fails fast on WA error", async () => {
    const rawSecret = "hook-hmac-secret-32-bytes-minimum";
    const whsec = "v1,whsec_" + Buffer.from(rawSecret).toString("base64");
    const fixedNowMs = 1_700_000_000_000;
    const nowSec = Math.floor(fixedNowMs / 1000);
    const limiter = new OtpRateLimiter({ phoneCooldownMs: 30_000, phoneMaxRequests: 5, ipMaxRequests: 20 });

    const signHook = (bodyStr: string, tsSec = nowSec) => {
      const msgId = "msg_123";
      const sig = crypto
        .createHmac("sha256", Buffer.from(rawSecret))
        .update(`${msgId}.${tsSec}.${bodyStr}`)
        .digest("base64");
      return {
        "webhook-id": msgId,
        "webhook-timestamp": String(tsSec),
        "webhook-signature": `v1,${sig}`,
      };
    };

    const leakedSecretHandler = createSendSmsOtpHandler({
      getEnv: makeEnv({ WA_SERVER_SECRET: COMPROMISED_DEFAULT_WA_SECRET }),
      rateLimiter: limiter,
      nowFn: () => fixedNowMs,
    });
    const leakedResp = await leakedSecretHandler(new Request("https://fn.test", { method: "POST", body: "{}" }));
    expect(leakedResp.status).toBe(500);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const fetchCalls: Array<{ url: string; secret: string | null }> = [];
    const handler = createSendSmsOtpHandler({
      getEnv: makeEnv({ SEND_SMS_HOOK_SECRET: whsec }),
      rateLimiter: limiter,
      nowFn: () => fixedNowMs,
      fetchFn: async (input, init) => {
        fetchCalls.push({
          url: String(input),
          secret: (init?.headers as Record<string, string>)?.["x-server-secret"] ?? null,
        });
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      },
    });

    const payload = JSON.stringify({ user: { phone: "+919876543210" }, sms: { otp: "654321" } });

    const noAuth = await handler(new Request("https://fn.test", { method: "POST", body: payload }));
    expect(noAuth.status).toBe(401);

    const staleSig = await handler(
      new Request("https://fn.test", {
        method: "POST",
        headers: signHook(payload, nowSec - 600),
        body: payload,
      }),
    );
    expect(staleSig.status).toBe(401);

    const ok = await handler(
      new Request("https://fn.test", {
        method: "POST",
        headers: { ...signHook(payload), "x-real-ip": "203.0.113.10" },
        body: payload,
      }),
    );
    expect(ok.status).toBe(200);
    expect(fetchCalls[0]).toEqual({
      url: "https://wa.pgbuddy.example/api/send-otp",
      secret: "super-strong-wa-secret-999",
    });
    // Ensure OTP is never logged in plaintext
    expect(logSpy.mock.calls.flat().join(" ")).not.toContain("654321");
    logSpy.mockRestore();

    // Immediate second call hits per-phone cooldown 429
    const limited = await handler(
      new Request("https://fn.test", {
        method: "POST",
        headers: { ...signHook(payload), "x-real-ip": "203.0.113.10" },
        body: payload,
      }),
    );
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBeTruthy();

    // Verify StandardWebhooks check helper directly
    const badCheck = await verifyStandardWebhookSignature(payload, new Headers(), whsec, nowSec);
    expect(badCheck.ok).toBe(false);
  });

  it("twilio-notifications blocks unauthenticated callers, blocks tenants from owner actions, and allows owner/assigned tenant", async () => {
    let currentUserId: string | null = "tenant-1";
    const handler = createTwilioNotificationsHandler({
      createClient: (_url, key) => ({
        auth: {
          async getUser() {
            if (key === "anon-jwt-key" && currentUserId) {
              return { data: { user: { id: currentUserId, email: "t@example.com" } }, error: null };
            }
            return { data: { user: null }, error: { message: "bad" } };
          },
        },
        from(table: string) {
          const filters: Record<string, unknown> = {};
          const resolveRows = () => {
            if (table === "properties") {
              if (filters.owner_id === "tenant-1") return [];
              return [{ id: "prop-1", owner_id: "owner-1", name: "PG One" }];
            }
            if (table === "staff_members") return [];
            if (table === "user_roles") return [];
            if (table === "tenant_assignments") {
              return filters.property_id === "prop-1"
                ? [{ id: "a1", tenant_id: "tenant-1", tenant_phone: "9876543210" }]
                : [];
            }
            if (table === "profiles") {
              return [{ user_id: "owner-1", phone: "9999988888", full_name: "Owner" }];
            }
            return [];
          };
          const chain = {
            eq(col: string, val: unknown) {
              filters[col] = val;
              return chain;
            },
            in() {
              return chain;
            },
            or() {
              return chain;
            },
            limit() {
              return chain;
            },
            async maybeSingle() {
              const rows = resolveRows();
              return { data: rows[0] ?? null, error: null };
            },
            async single() {
              const rows = resolveRows();
              return { data: rows[0] ?? null, error: null };
            },
            then<TResult1 = { data: Record<string, unknown>[]; error: null }>(
              onfulfilled?: ((value: { data: Record<string, unknown>[]; error: null }) => TResult1 | PromiseLike<TResult1>) | null,
            ) {
              return Promise.resolve({ data: resolveRows(), error: null }).then(onfulfilled ?? undefined);
            },
          };
          return { select: () => chain };
        },
      }),
      fetchFn: async () => new Response(JSON.stringify({ success: true }), { status: 200 }),
      getEnv: makeEnv(),
    });

    currentUserId = null;
    const unauth = await handler(
      new Request("https://fn.test", {
        method: "POST",
        body: JSON.stringify({ action: "send-announcement", property_id: "prop-1" }),
      }),
    );
    expect(unauth.status).toBe(401);

    currentUserId = "tenant-1";
    const tenantAnnouncement = await handler(
      new Request("https://fn.test", {
        method: "POST",
        headers: { Authorization: "Bearer user-jwt" },
        body: JSON.stringify({ action: "send-announcement", property_id: "prop-1" }),
      }),
    );
    expect(tenantAnnouncement.status).toBe(403);

    const tenantComplaint = await handler(
      new Request("https://fn.test", {
        method: "POST",
        headers: { Authorization: "Bearer user-jwt" },
        body: JSON.stringify({ action: "send-complaint-alert", property_id: "prop-1", title: "Leak" }),
      }),
    );
    expect(tenantComplaint.status).toBe(200);

    currentUserId = "owner-1";
    const ownerAnnouncement = await handler(
      new Request("https://fn.test", {
        method: "POST",
        headers: { Authorization: "Bearer user-jwt" },
        body: JSON.stringify({ action: "send-announcement", property_id: "prop-1", title: "Notice" }),
      }),
    );
    expect(ownerAnnouncement.status).toBe(200);
  });
});

describe("S5 & WhatsApp server security (whatsapp-server/server.js & campaign-worker.js)", () => {
  const waPkg = path.join(ROOT, "whatsapp-server/package.json");
  const waRequire = createRequire(waPkg);
  const hasWaNodeModules = (() => {
    try {
      waRequire.resolve("dotenv");
      waRequire.resolve("express");
      return true;
    } catch {
      return false;
    }
  })();

  function loadWithWaFallback<T>(modulePath: string): T {
    if (hasWaNodeModules) {
      return require(modulePath) as T;
    }
    const NodeModule = require("node:module");
    const httpMod = require("node:http") as typeof import("node:http");
    const origLoad = NodeModule._load;

    const createMiniExpress = () => {
      const routes: Array<{ method: string; path: string; handlers: Array<(req: unknown, res: unknown, next: () => void) => void> }> = [];
      const globalMiddlewares: Array<(req: unknown, res: unknown, next: () => void) => void> = [];
      const app = (rawReq: import("node:http").IncomingMessage, rawRes: import("node:http").ServerResponse) => {
        const chunks: Buffer[] = [];
        rawReq.on("data", (c: Buffer) => chunks.push(c));
        rawReq.on("end", () => {
          const bodyStr = Buffer.concat(chunks).toString("utf8");
          let parsedBody: unknown = {};
          try {
            parsedBody = bodyStr ? JSON.parse(bodyStr) : {};
          } catch {
            parsedBody = {};
          }
          const reqObj = {
            method: rawReq.method,
            url: rawReq.url,
            headers: rawReq.headers,
            body: parsedBody,
          };
          let statusCode = 200;
          const resObj = {
            status(code: number) {
              statusCode = code;
              return resObj;
            },
            json(payload: unknown) {
              rawRes.statusCode = statusCode;
              rawRes.setHeader("Content-Type", "application/json");
              rawRes.end(JSON.stringify(payload));
              return resObj;
            },
          };
          const matched = routes.find((r) => r.method === rawReq.method && r.path === rawReq.url);
          const chain = [...globalMiddlewares, ...(matched ? matched.handlers : [])];
          let idx = 0;
          const next = () => {
            const fn = chain[idx++];
            if (fn) fn(reqObj, resObj, next);
            else if (!rawRes.writableEnded) {
              rawRes.statusCode = 404;
              rawRes.end(JSON.stringify({ error: "Not found" }));
            }
          };
          next();
        });
      };
      app.use = (mw: (req: unknown, res: unknown, next: () => void) => void) => {
        globalMiddlewares.push(mw);
      };
      app.get = (p: string, ...handlers: Array<(req: unknown, res: unknown, next: () => void) => void>) => {
        routes.push({ method: "GET", path: p, handlers });
      };
      app.post = (p: string, ...handlers: Array<(req: unknown, res: unknown, next: () => void) => void>) => {
        routes.push({ method: "POST", path: p, handlers });
      };
      app.listen = (port: number, host: string, cb?: () => void) => {
        const srv = httpMod.createServer(app);
        srv.listen(port, host, cb);
        return srv;
      };
      return app;
    };
    createMiniExpress.json = () => (_req: unknown, _res: unknown, next: () => void) => next();

    const stubs: Record<string, unknown> = {
      dotenv: { config: () => ({}) },
      express: createMiniExpress,
      "express-rate-limit": () => (_req: unknown, _res: unknown, next: () => void) => next(),
      "whatsapp-web.js": { Client: function () {}, LocalAuth: function () {}, MessageMedia: { fromFilePath: () => ({}) } },
      "qrcode-terminal": { generate: () => {} },
      "@supabase/supabase-js": { createClient: () => ({}) },
      axios: { post: async () => ({ data: { success: true } }) },
    };

    NodeModule._load = function (request: string, parent: unknown, isMain: boolean) {
      if (Object.prototype.hasOwnProperty.call(stubs, request)) {
        return stubs[request];
      }
      return origLoad.call(this, request, parent, isMain);
    };
    try {
      delete require.cache[require.resolve(modulePath)];
      return require(modulePath) as T;
    } finally {
      NodeModule._load = origLoad;
    }
  }

  it("refuses startup when SERVER_SECRET is unset or uses the leaked placeholder", () => {
    const serverMod = loadWithWaFallback<{
      validateServerConfig: (env?: Record<string, string | undefined>) => unknown;
    }>(path.join(ROOT, "whatsapp-server/server.js"));
    const workerMod = loadWithWaFallback<{
      validateWorkerConfig: (env?: Record<string, string | undefined>) => unknown;
    }>(path.join(ROOT, "whatsapp-server/campaign-worker.js"));

    expect(() =>
      serverMod.validateServerConfig({ SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "key" }),
    ).toThrow(/SERVER_SECRET/i);
    expect(() =>
      serverMod.validateServerConfig({
        SUPABASE_URL: "https://x.supabase.co",
        SUPABASE_SERVICE_ROLE_KEY: "key",
        SERVER_SECRET: COMPROMISED_DEFAULT_WA_SECRET,
      }),
    ).toThrow(/placeholder/i);
    expect(() =>
      workerMod.validateWorkerConfig({ SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "key" }),
    ).toThrow(/SERVER_SECRET/i);

    let preloadFile: string | null = null;
    const spawnArgs: string[] = [];
    if (!hasWaNodeModules) {
      const osMod = require("node:os") as typeof import("node:os");
      preloadFile = path.join(osMod.tmpdir(), `wa-worker-stub-${process.pid}-${Date.now()}.cjs`);
      fs.writeFileSync(
        preloadFile,
        `const Module = require("node:module");
const orig = Module._load;
const stubs = { dotenv: { config: () => ({}) }, "@supabase/supabase-js": { createClient: () => ({}) }, axios: {} };
Module._load = function(req, parent, isMain) {
  if (Object.prototype.hasOwnProperty.call(stubs, req)) return stubs[req];
  return orig.call(this, req, parent, isMain);
};
`,
      );
      spawnArgs.push("-r", preloadFile);
    }
    spawnArgs.push(path.join(ROOT, "whatsapp-server/campaign-worker.js"));

    try {
      const spawnRes = spawnSync(process.execPath, spawnArgs, {
        env: {
          PATH: process.env.PATH || "",
          SUPABASE_URL: "https://example.supabase.co",
          SUPABASE_SERVICE_ROLE_KEY: "dummy-service-role",
        },
        timeout: 1500,
        encoding: "utf8",
      });
      expect(spawnRes.status).not.toBe(0);
      expect(spawnRes.stderr + spawnRes.stdout).toMatch(/SERVER_SECRET/i);
    } finally {
      if (preloadFile) {
        try {
          fs.unlinkSync(preloadFile);
        } catch {
          // ignore cleanup error
        }
      }
    }
  });

  it("enforces constant-time auth, OTP cooldown (429), and media path traversal rejection over HTTP", async () => {
    const serverMod = loadWithWaFallback<{
      resolveSafeMediaPath: (raw: string, baseDir?: string) => string | null;
      createApp: (opts: Record<string, unknown>) => { listen: (port: number, host: string, cb: () => void) => http.Server };
    }>(path.join(ROOT, "whatsapp-server/server.js"));
    expect(serverMod.resolveSafeMediaPath("../.env", "/app/wa")).toBeNull();
    expect(serverMod.resolveSafeMediaPath("/etc/passwd", "/app/wa")).toBeNull();
    expect(serverMod.resolveSafeMediaPath("./campaign.png", "/app/wa")).toBe("/app/wa/campaign.png");

    const app = serverMod.createApp({
      serverSecret: "real-wa-server-secret-abc",
      supabase: { from: () => ({ insert: async () => ({ error: null }) }) },
      getClient: () => ({
        isRegisteredUser: async () => true,
        sendMessage: async () => {},
      }),
      isReadyFn: () => true,
      otpCooldownMs: 30_000,
    });

    const server = await new Promise<http.Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    try {
      const addr = server.address() as { port: number };
      const base = `http://127.0.0.1:${addr.port}`;

      const unauth = await fetch(`${base}/api/send-otp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phoneNumber: "9876543210", otp: "123456" }),
      });
      expect(unauth.status).toBe(401);

      const firstOtp = await fetch(`${base}/api/send-otp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-server-secret": "real-wa-server-secret-abc",
        },
        body: JSON.stringify({ phoneNumber: "9876543210", otp: "123456" }),
      });
      expect(firstOtp.status).toBe(200);

      const secondOtp = await fetch(`${base}/api/send-otp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-server-secret": "real-wa-server-secret-abc",
        },
        body: JSON.stringify({ phoneNumber: "9876543210", otp: "123456" }),
      });
      expect(secondOtp.status).toBe(429);

      const traversal = await fetch(`${base}/api/send-instant`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-server-secret": "real-wa-server-secret-abc",
        },
        body: JSON.stringify({ phoneNumber: "9876543210", message: "hi", imagePath: "../.env" }),
      });
      expect(traversal.status).toBe(400);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
