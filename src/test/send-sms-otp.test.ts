// @vitest-environment node
// The Supabase Auth "Send SMS" hook (supabase/functions/send-sms-otp).
import { describe, expect, it, vi } from "vitest";
import { createHmac, randomBytes } from "node:crypto";
import { createSendSmsOtpHandler, maskPhone } from "../../supabase/functions/send-sms-otp/handler.ts";

const KEY = randomBytes(32);
const SECRET = `v1,whsec_${KEY.toString("base64")}`;
const NOW = 1_800_000_000;
const PHONE = "919876543210";
const CODE = "482913";

type Call = { url: string; body: Record<string, unknown> | null };

function sign(body: string, opts: { key?: Buffer; ts?: number; id?: string } = {}) {
  const id = opts.id ?? "msg_1";
  const ts = String(opts.ts ?? NOW);
  const sig = createHmac("sha256", opts.key ?? KEY).update(`${id}.${ts}.${body}`).digest("base64");
  return { "webhook-id": id, "webhook-timestamp": ts, "webhook-signature": `v1,${sig}` };
}

function setup(opts: {
  env?: Record<string, string | undefined>;
  cloud?: (call: Call) => Response;
  waServer?: (call: Call) => Response;
} = {}) {
  const calls: Call[] = [];
  const env: Record<string, string | undefined> = {
    SEND_SMS_HOOK_SECRET: SECRET,
    WHATSAPP_TOKEN: "EAAtest",
    WHATSAPP_PHONE_NUMBER_ID: "1553178531205507",
    WA_SERVER_URL: "https://wa.example.com/",
    WA_SERVER_SECRET: "server-secret",
    ...opts.env,
  };
  const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    const call = { url, body };
    calls.push(call);
    if (url.startsWith("https://graph.facebook.com/")) {
      return opts.cloud ? opts.cloud(call) : new Response(JSON.stringify({ messages: [{ id: "wamid.1" }] }), { status: 200 });
    }
    return opts.waServer ? opts.waServer(call) : new Response(JSON.stringify({ success: true }), { status: 200 });
  }) as unknown as typeof fetch;
  const handler = createSendSmsOtpHandler({ getEnv: (n) => env[n], fetchFn, nowSeconds: () => NOW });
  const send = (payload: unknown = { user: { phone: PHONE }, sms: { otp: CODE } }, headers?: Record<string, string>) => {
    const body = JSON.stringify(payload);
    return handler(new Request("https://fn.example/send-sms-otp", { method: "POST", body, headers: headers ?? sign(body) }));
  };
  return { send, calls, handler };
}

const metaError = (code: number) => new Response(JSON.stringify({ error: { code, message: "x" } }), { status: 400 });

describe("send-sms-otp hook", () => {
  it("sends the code with the approved login_otp template, code in body and Copy code button", async () => {
    const t = setup();
    const res = await t.send();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0].url).toBe("https://graph.facebook.com/v25.0/1553178531205507/messages");
    expect(t.calls[0].body).toMatchObject({
      to: PHONE,
      type: "template",
      template: {
        name: "login_otp",
        language: { code: "en" },
        components: [
          { type: "body", parameters: [{ type: "text", text: CODE }] },
          { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: CODE }] },
        ],
      },
    });
  });

  it("falls back to the WhatsApp server when the Cloud API fails", async () => {
    const t = setup({ cloud: () => metaError(131000) });
    const res = await t.send();
    expect(res.status).toBe(200);
    expect(t.calls.map((c) => c.url)).toEqual([
      "https://graph.facebook.com/v25.0/1553178531205507/messages",
      "https://wa.example.com/api/send-otp",
    ]);
    expect(t.calls[1].body).toEqual({ phoneNumber: PHONE, otp: CODE });
  });

  it("uses only the WhatsApp server when the Cloud API is not configured", async () => {
    const t = setup({ env: { WHATSAPP_TOKEN: undefined } });
    expect((await t.send()).status).toBe(200);
    expect(t.calls.map((c) => c.url)).toEqual(["https://wa.example.com/api/send-otp"]);
  });

  it("reports an error instead of pretending success when nothing delivered", async () => {
    const t = setup({ cloud: () => metaError(131000), waServer: () => { throw new TypeError("dns error"); } });
    const res = await t.send();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: { http_code: 500, message: expect.stringContaining("Could not send the code") } });
  });

  it("does not count an HTML/garbled WhatsApp server reply as delivered", async () => {
    const t = setup({ env: { WHATSAPP_TOKEN: undefined }, waServer: () => new Response("<html>tunnel</html>", { status: 502 }) });
    expect((await t.send()).status).toBe(500);
  });

  it("tells the user when the number is not on WhatsApp, without trying the server", async () => {
    const t = setup({ cloud: () => metaError(131026) });
    const res = await t.send();
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toMatch(/not on WhatsApp/);
    expect(t.calls).toHaveLength(1);
  });

  it("never uses the old hard-coded WhatsApp server secret", async () => {
    const t = setup({ env: { WHATSAPP_TOKEN: undefined, WA_SERVER_SECRET: "pg_buddy_whatsapp_secret_2024" } });
    expect((await t.send()).status).toBe(500);
    expect(t.calls).toHaveLength(0);
  });

  describe("only Supabase Auth may call it", () => {
    const body = JSON.stringify({ user: { phone: PHONE }, sms: { otp: CODE } });

    it("rejects a request with no signature, and sends nothing", async () => {
      const t = setup();
      expect((await t.send(undefined, {})).status).toBe(401);
      expect(t.calls).toHaveLength(0);
    });

    it("rejects a signature made with another key", async () => {
      const t = setup();
      expect((await t.send(undefined, sign(body, { key: randomBytes(32) }))).status).toBe(401);
      expect(t.calls).toHaveLength(0);
    });

    it("rejects a signed body that was changed (different phone)", async () => {
      const t = setup();
      const res = await t.send({ user: { phone: "919999999999" }, sms: { otp: CODE } }, sign(body));
      expect(res.status).toBe(401);
      expect(t.calls).toHaveLength(0);
    });

    it("rejects an old (replayed) request", async () => {
      const t = setup();
      expect((await t.send(undefined, sign(body, { ts: NOW - 6 * 60 }))).status).toBe(401);
    });

    it("accepts one valid signature among several", async () => {
      const t = setup();
      const good = sign(body);
      const res = await t.send(undefined, { ...good, "webhook-signature": `v1,AAAA ${good["webhook-signature"]}` });
      expect(res.status).toBe(200);
    });

    it("refuses to run without the secret", async () => {
      const t = setup({ env: { SEND_SMS_HOOK_SECRET: undefined } });
      expect((await t.send()).status).toBe(500);
      expect(t.calls).toHaveLength(0);
    });

    it("rejects GET", async () => {
      const t = setup();
      expect((await t.handler(new Request("https://fn.example/send-sms-otp"))).status).toBe(405);
    });
  });

  it("rejects a malformed code", async () => {
    const t = setup();
    expect((await t.send({ user: { phone: PHONE }, sms: { otp: "12ab" } })).status).toBe(400);
    expect(t.calls).toHaveLength(0);
  });

  it("never writes the code or the full phone number to the logs", async () => {
    const logs: string[] = [];
    const spies = (["log", "warn", "error", "info"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")); }),
    );
    try {
      await setup().send();
      await setup({ cloud: () => metaError(131000), waServer: () => new Response("no", { status: 500 }) }).send();
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
    const all = logs.join("\n");
    expect(all).not.toContain(CODE);
    expect(all).not.toContain("9876543210");
    expect(all).toContain("…3210");
  });

  it("masks phone numbers for the logs", () => {
    expect(maskPhone("+91 98765 43210")).toBe("…3210");
  });
});
