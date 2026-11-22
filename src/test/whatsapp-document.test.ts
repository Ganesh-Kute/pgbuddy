// @vitest-environment node
import path from "node:path";
import { createRequire } from "node:module";
import type http from "node:http";
import { describe, expect, it, vi } from "vitest";

const ROOT = path.resolve(__dirname, "../..");
const require = createRequire(import.meta.url);

interface MockMediaInstance {
  mimetype: string;
  data: string;
  filename: string | null | undefined;
}

interface ServerMod {
  createApp: (opts: Record<string, unknown>) => {
    listen: (port: number, host: string, cb: () => void) => http.Server;
  };
  validateDocumentPayload?: (body: Record<string, unknown>) => {
    ok: boolean;
    error?: string;
  };
  DOCUMENT_FILENAME_REGEX?: RegExp;
  MAX_DOCUMENT_BYTES?: number;
}

function loadServerForDocumentTest(): {
  serverMod: ServerMod;
  mediaCalls: MockMediaInstance[];
  jsonParserConfigs: Array<Record<string, unknown> | undefined>;
} {
  const NodeModule = require("node:module");
  const httpMod = require("node:http") as typeof import("node:http");
  const origLoad = NodeModule._load;
  const mediaCalls: MockMediaInstance[] = [];
  const jsonParserConfigs: Array<Record<string, unknown> | undefined> = [];

  function parseByteLimit(limit: unknown): number {
    if (typeof limit === "number") return limit;
    if (typeof limit !== "string") return 100 * 1024;
    const m = /^(\d+(?:\.\d+)?)\s*(kb|mb|b)?$/i.exec(limit.trim());
    if (!m) return 100 * 1024;
    const n = Number(m[1]);
    const unit = (m[2] || "b").toLowerCase();
    if (unit === "mb") return Math.floor(n * 1024 * 1024);
    if (unit === "kb") return Math.floor(n * 1024);
    return Math.floor(n);
  }

  const createMiniExpress = () => {
    type HandlerFn = (req: Record<string, unknown>, res: Record<string, unknown>, next: () => void) => void;
    const routes: Array<{ method: string; path: string; handlers: HandlerFn[] }> = [];
    const globalMiddlewares: HandlerFn[] = [];

    const app = (rawReq: http.IncomingMessage, rawRes: http.ServerResponse) => {
      const chunks: Buffer[] = [];
      rawReq.on("data", (c: Buffer) => chunks.push(c));
      rawReq.on("end", () => {
        const rawBuf = Buffer.concat(chunks);
        const rawUrl = rawReq.url || "/";
        const reqPath = rawUrl.split("?")[0];
        const reqObj: Record<string, unknown> = {
          method: rawReq.method,
          url: rawUrl,
          path: reqPath,
          headers: rawReq.headers,
          rawByteLength: rawBuf.length,
          rawBodyStr: rawBuf.toString("utf8"),
          body: {},
        };

        let statusCode = 200;
        const resObj: Record<string, unknown> = {
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

        const matched = routes.find((r) => r.method === rawReq.method && r.path === reqPath);
        const chain = [...globalMiddlewares, ...(matched ? matched.handlers : [])];
        let idx = 0;
        const next = () => {
          const fn = chain[idx++];
          if (fn) {
            fn(reqObj, resObj, next);
          } else if (!rawRes.writableEnded) {
            rawRes.statusCode = 404;
            rawRes.end(JSON.stringify({ error: "Not found" }));
          }
        };
        next();
      });
    };

    app.use = (mw: HandlerFn) => {
      globalMiddlewares.push(mw);
    };
    app.get = (p: string, ...handlers: HandlerFn[]) => {
      routes.push({ method: "GET", path: p, handlers });
    };
    app.post = (p: string, ...handlers: HandlerFn[]) => {
      routes.push({ method: "POST", path: p, handlers });
    };
    app.listen = (port: number, host: string, cb?: () => void) => {
      const srv = httpMod.createServer(app);
      srv.listen(port, host, cb);
      return srv;
    };
    return app;
  };

  createMiniExpress.json = (opts?: Record<string, unknown>) => {
    jsonParserConfigs.push(opts);
    const maxBytes = parseByteLimit(opts?.limit);
    return (req: Record<string, unknown>, res: Record<string, unknown>, next: () => void) => {
      const byteLen = Number(req.rawByteLength || 0);
      if (byteLen > maxBytes) {
        (res.status as (code: number) => { json: (p: unknown) => void })(413).json({
          error: "Payload too large",
        });
        return;
      }
      const rawStr = String(req.rawBodyStr || "");
      try {
        req.body = rawStr ? JSON.parse(rawStr) : {};
      } catch {
        (res.status as (code: number) => { json: (p: unknown) => void })(400).json({
          error: "Invalid JSON",
        });
        return;
      }
      next();
    };
  };

  class StubMessageMedia {
    mimetype: string;
    data: string;
    filename: string | null | undefined;
    constructor(mimetype: string, data: string, filename?: string | null) {
      this.mimetype = mimetype;
      this.data = data;
      this.filename = filename;
      mediaCalls.push({ mimetype, data, filename });
    }
  }

  const stubs: Record<string, unknown> = {
    dotenv: { config: () => ({}) },
    express: createMiniExpress,
    "express-rate-limit": () => (_req: unknown, _res: unknown, next: () => void) => next(),
    "whatsapp-web.js": {
      Client: function () {},
      LocalAuth: function () {},
      MessageMedia: StubMessageMedia,
    },
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

  const serverPath = path.join(ROOT, "whatsapp-server/server.js");
  try {
    delete require.cache[require.resolve(serverPath)];
    const serverMod = require(serverPath) as ServerMod;
    return { serverMod, mediaCalls, jsonParserConfigs };
  } finally {
    NodeModule._load = origLoad;
  }
}

function makePdfBase64(totalBytes = 128): string {
  const header = Buffer.from("%PDF-1.4\n%mock-receipt\n", "ascii");
  if (totalBytes <= header.length) {
    return header.subarray(0, totalBytes).toString("base64");
  }
  const pad = Buffer.alloc(totalBytes - header.length, 0x20);
  return Buffer.concat([header, pad]).toString("base64");
}

describe("POST /api/send-document (whatsapp-server/server.js)", () => {
  it("validates auth, filename, mimetype, %PDF- base64, and 1 MB decoded limit; enforces 2 MB JSON limit on /api/send-document only", async () => {
    const { serverMod, mediaCalls, jsonParserConfigs } = loadServerForDocumentTest();
    const isRegisteredUser = vi.fn<(phone: string) => Promise<boolean>>(async () => true);
    const sendMessage = vi.fn<
      (to: string, media: unknown, options?: Record<string, unknown>) => Promise<{ id: string }>
    >(async () => ({ id: "msg-1" }));
    let ready = true;

    const app = serverMod.createApp({
      serverSecret: "doc-secret-xyz-123",
      supabase: { from: () => ({ insert: async () => ({ error: null }) }) },
      getClient: () => ({ isRegisteredUser, sendMessage }),
      isReadyFn: () => ready,
    });

    // Verify express.json includes both default parser and 2mb parser for /api/send-document
    expect(jsonParserConfigs.some((cfg) => cfg?.limit === "2mb")).toBe(true);

    const server = await new Promise<http.Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });

    try {
      const addr = server.address() as { port: number };
      const base = `http://127.0.0.1:${addr.port}`;
      const validBase64 = makePdfBase64(256);

      // 1. Unauthorized
      const unauth = await fetch(`${base}/api/send-document`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phoneNumber: "9876543210",
          base64: validBase64,
          mimetype: "application/pdf",
          filename: "PGB-1234ABCD.pdf",
        }),
      });
      expect(unauth.status).toBe(401);

      // 2. Non-PDF mimetype
      const badMime = await fetch(`${base}/api/send-document`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-server-secret": "doc-secret-xyz-123" },
        body: JSON.stringify({
          phoneNumber: "9876543210",
          base64: validBase64,
          mimetype: "image/png",
          filename: "PGB-1234ABCD.pdf",
        }),
      });
      expect(badMime.status).toBe(400);

      // 3. Bad filenames (traversal, wrong extension, too long, double-dot)
      for (const badName of ["../evil.pdf", "dir/file.pdf", "receipt.exe", "..pdf", `${"a".repeat(81)}.pdf`, ""]) {
        const res = await fetch(`${base}/api/send-document`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-server-secret": "doc-secret-xyz-123" },
          body: JSON.stringify({
            phoneNumber: "9876543210",
            base64: validBase64,
            mimetype: "application/pdf",
            filename: badName,
          }),
        });
        expect(res.status, `filename "${badName}"`).toBe(400);
      }

      // 4. Invalid phone
      const badPhone = await fetch(`${base}/api/send-document`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-server-secret": "doc-secret-xyz-123" },
        body: JSON.stringify({
          phoneNumber: "12345",
          base64: validBase64,
          mimetype: "application/pdf",
          filename: "PGB-1234ABCD.pdf",
        }),
      });
      expect(badPhone.status).toBe(400);

      // 5. Base64 that does not decode to %PDF-
      const nonPdfPayload = await fetch(`${base}/api/send-document`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-server-secret": "doc-secret-xyz-123" },
        body: JSON.stringify({
          phoneNumber: "9876543210",
          base64: Buffer.from("<html>not a pdf</html>").toString("base64"),
          mimetype: "application/pdf",
          filename: "PGB-1234ABCD.pdf",
        }),
      });
      expect(nonPdfPayload.status).toBe(400);

      // 6. Over 1 MB decoded PDF size rejected with 400
      const over1Mb = await fetch(`${base}/api/send-document`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-server-secret": "doc-secret-xyz-123" },
        body: JSON.stringify({
          phoneNumber: "9876543210",
          base64: makePdfBase64(1024 * 1024 + 1),
          mimetype: "application/pdf",
          filename: "PGB-LARGE.pdf",
        }),
      });
      expect(over1Mb.status).toBe(400);
      expect(isRegisteredUser).not.toHaveBeenCalled();

      // 7. Other routes keep default 100 KB limit while /api/send-document accepts > 100 KB (<= 2 MB)
      const largeInstant = await fetch(`${base}/api/send-instant`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-server-secret": "doc-secret-xyz-123" },
        body: JSON.stringify({ phoneNumber: "9876543210", message: "x".repeat(150 * 1024) }),
      });
      expect(largeInstant.status).toBe(413);

      // 8. Client not ready -> 503
      ready = false;
      const notReady = await fetch(`${base}/api/send-document`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-server-secret": "doc-secret-xyz-123" },
        body: JSON.stringify({
          phoneNumber: "9876543210",
          base64: validBase64,
          mimetype: "application/pdf",
          filename: "PGB-1234ABCD.pdf",
        }),
      });
      expect(notReady.status).toBe(503);
      ready = true;

      // 9. Number not registered on WhatsApp -> 404
      isRegisteredUser.mockResolvedValueOnce(false);
      const notOnWa = await fetch(`${base}/api/send-document`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-server-secret": "doc-secret-xyz-123" },
        body: JSON.stringify({
          phoneNumber: "9876543210",
          base64: validBase64,
          mimetype: "application/pdf",
          filename: "PGB-1234ABCD.pdf",
        }),
      });
      expect(notOnWa.status).toBe(404);

      // 10. Exact 1 MB PDF boundary succeeds (> 100 KB JSON body) with MessageMedia + sendMediaAsDocument: true
      const exact1MbBase64 = makePdfBase64(1024 * 1024);
      const ok1Mb = await fetch(`${base}/api/send-document`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-server-secret": "doc-secret-xyz-123" },
        body: JSON.stringify({
          phoneNumber: "+91 98765-43210",
          base64: exact1MbBase64,
          mimetype: "application/pdf",
          filename: "PGB-2026 04.pdf",
          caption: "Receipt for April 2026",
        }),
      });
      expect(ok1Mb.status).toBe(200);
      const okJson = (await ok1Mb.json()) as { sent?: boolean; success?: boolean };
      expect(okJson.sent).toBe(true);
      expect(isRegisteredUser).toHaveBeenCalledWith("919876543210@c.us");
      expect(mediaCalls[0]).toEqual({
        mimetype: "application/pdf",
        data: exact1MbBase64,
        filename: "PGB-2026 04.pdf",
      });
      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(sendMessage.mock.calls[0][0]).toBe("919876543210@c.us");
      expect(sendMessage.mock.calls[0][2]).toEqual({
        caption: "Receipt for April 2026",
        sendMediaAsDocument: true,
      });

      // 11. Client send failure -> 500 without leaking raw internal error
      sendMessage.mockRejectedValueOnce(new Error("Puppeteer detached"));
      const sendErr = await fetch(`${base}/api/send-document`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-server-secret": "doc-secret-xyz-123" },
        body: JSON.stringify({
          phoneNumber: "9876543210",
          base64: validBase64,
          mimetype: "application/pdf",
          filename: "PGB-1234ABCD.pdf",
        }),
      });
      expect(sendErr.status).toBe(500);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
