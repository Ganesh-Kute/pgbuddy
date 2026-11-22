require("dotenv").config();
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const express = require("express");
const rateLimit = require("express-rate-limit");
const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const { createClient } = require("@supabase/supabase-js");
const os = require("os");

const COMPROMISED_DEFAULT_SECRET = ["pg_buddy", "whatsapp", "secret", "2024"].join("_");
const MAX_DOCUMENT_BYTES = 1024 * 1024;
const DOCUMENT_FILENAME_REGEX = /^[\w\- .]{1,80}\.pdf$/;

function validateServerConfig(env = process.env) {
  const secret = typeof env.SERVER_SECRET === "string" ? env.SERVER_SECRET.trim() : "";
  if (!secret) {
    throw new Error("Missing SERVER_SECRET environment variable. Refusing to start without a configured secret.");
  }
  if (secret === COMPROMISED_DEFAULT_SECRET) {
    throw new Error("SERVER_SECRET must not use the leaked example placeholder. Set a unique secret.");
  }
  if (secret.length < 32) {
    throw new Error("SERVER_SECRET is too short (needs 32+ characters). Use the same value as WA_SERVER_SECRET in Supabase.");
  }
  const supabaseUrl = typeof env.SUPABASE_URL === "string" ? env.SUPABASE_URL.trim() : "";
  const serviceKey = typeof env.SUPABASE_SERVICE_ROLE_KEY === "string" ? env.SUPABASE_SERVICE_ROLE_KEY.trim() : "";
  if (!supabaseUrl || !serviceKey) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables.");
  }
  return {
    port: Number(env.PORT) || 3001,
    serverSecret: secret,
    supabaseUrl,
    serviceKey,
    otpCooldownMs: Number(env.OTP_COOLDOWN_MS) || 30_000,
    brandName: env.BRAND_NAME || "PG Buddy",
  };
}

function timingSafeEqualStr(expected, provided) {
  if (typeof expected !== "string" || typeof provided !== "string" || !expected || !provided) {
    return false;
  }
  const a = crypto.createHash("sha256").update(expected, "utf8").digest();
  const b = crypto.createHash("sha256").update(provided, "utf8").digest();
  return crypto.timingSafeEqual(a, b);
}

function formatPhone(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  if (digits.length < 10 || digits.length > 15) {
    throw new Error("Invalid phone number: expected 10 to 15 digits");
  }
  const tenDigit = digits.slice(-10);
  return `91${tenDigit}@c.us`;
}

function resolveSafeMediaPath(rawPath, baseDir = __dirname) {
  if (typeof rawPath !== "string" || !rawPath.trim()) return null;
  if (path.isAbsolute(rawPath)) return null;
  const resolvedBase = path.resolve(baseDir);
  const resolvedTarget = path.resolve(resolvedBase, rawPath);
  if (resolvedTarget !== resolvedBase && !resolvedTarget.startsWith(resolvedBase + path.sep)) {
    return null;
  }
  return resolvedTarget;
}

function validateDocumentPayload(body) {
  const { phoneNumber, base64, mimetype, filename, caption } = body || {};
  if (phoneNumber === undefined || phoneNumber === null || String(phoneNumber).trim() === "") {
    return { ok: false, status: 400, error: "phoneNumber is required" };
  }

  let formattedPhone;
  try {
    formattedPhone = formatPhone(phoneNumber);
  } catch (e) {
    return { ok: false, status: 400, error: e.message };
  }

  if (typeof mimetype !== "string" || mimetype.trim().toLowerCase() !== "application/pdf") {
    return { ok: false, status: 400, error: "Only application/pdf documents are allowed" };
  }

  if (
    typeof filename !== "string" ||
    filename.startsWith(".") ||
    filename.includes("..") ||
    !DOCUMENT_FILENAME_REGEX.test(filename)
  ) {
    return { ok: false, status: 400, error: "Invalid filename: expected 1-80 safe characters ending in .pdf" };
  }

  if (typeof base64 !== "string" || !base64.trim()) {
    return { ok: false, status: 400, error: "base64 PDF content is required" };
  }

  const cleanBase64 = base64.replace(/\s+/g, "");
  if (cleanBase64.length > Math.ceil((MAX_DOCUMENT_BYTES * 4) / 3) + 4) {
    return { ok: false, status: 400, error: "PDF exceeds maximum decoded size of 1 MB" };
  }
  if (
    cleanBase64.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(cleanBase64)
  ) {
    return { ok: false, status: 400, error: "Invalid base64 encoding" };
  }

  const decoded = Buffer.from(cleanBase64, "base64");
  if (decoded.length === 0 || decoded.length > MAX_DOCUMENT_BYTES) {
    return { ok: false, status: 400, error: "PDF exceeds maximum decoded size of 1 MB" };
  }
  if (decoded.length < 5 || decoded.subarray(0, 5).toString("ascii") !== "%PDF-") {
    return { ok: false, status: 400, error: "Invalid PDF content: missing %PDF- header" };
  }

  if (caption !== undefined && caption !== null && typeof caption !== "string") {
    return { ok: false, status: 400, error: "caption must be a string" };
  }
  const cleanCaption = typeof caption === "string" ? caption.trim() : "";
  if (cleanCaption.length > 4096) {
    return { ok: false, status: 400, error: "caption exceeds maximum length" };
  }

  return {
    ok: true,
    formattedPhone,
    cleanBase64,
    filename,
    caption: cleanCaption,
  };
}

function createOtpLimiter(cooldownMs = 30_000) {
  const lastSent = new Map();
  return {
    isLimited(phoneKey, now = Date.now()) {
      if (lastSent.size > 1000) {
        for (const [k, ts] of lastSent.entries()) {
          if (now - ts >= cooldownMs) lastSent.delete(k);
        }
      }
      const last = lastSent.get(phoneKey);
      if (last === undefined) return false;
      return now - last < cooldownMs;
    },
    markSent(phoneKey, now = Date.now()) {
      lastSent.set(phoneKey, now);
    },
  };
}

function createAuthenticateMiddleware(serverSecret) {
  return function authenticate(req, res, next) {
    const headerSecret = req.headers["x-server-secret"];
    const authHeader = req.headers["authorization"];
    const bearer = typeof authHeader === "string" && authHeader.toLowerCase().startsWith("bearer ")
      ? authHeader.slice(7).trim()
      : "";
    const provided =
      (typeof headerSecret === "string" && headerSecret.trim()) ||
      bearer ||
      (typeof req.body?.secret === "string" ? req.body.secret.trim() : "");

    if (!timingSafeEqualStr(serverSecret, provided)) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    return next();
  };
}

function createApp({
  serverSecret,
  supabase,
  getClient,
  isReadyFn,
  otpCooldownMs = 30_000,
  brandName = "PG Buddy",
  mediaBaseDir = __dirname,
}) {
  const app = express();
  const defaultJsonParser = express.json();
  const documentJsonParser = express.json({ limit: "2mb" });
  app.use((req, res, next) => {
    const reqPath = req.path || String(req.url || "").split("?")[0];
    if (req.method === "POST" && reqPath === "/api/send-document") {
      return documentJsonParser(req, res, next);
    }
    return defaultJsonParser(req, res, next);
  });

  const authenticate = createAuthenticateMiddleware(serverSecret);
  const otpLimiter = createOtpLimiter(otpCooldownMs);
  const campaignPhones = new Set();

  const apiRateLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests, slow down." },
  });

  app.get("/health", (_req, res) => {
    const ready = isReadyFn();
    res.json({
      status: ready ? "ready" : "not_ready",
      message: ready ? "WhatsApp is connected" : "WhatsApp is not connected yet",
    });
  });

  app.post("/api/send-otp", apiRateLimiter, authenticate, async (req, res) => {
    const { phoneNumber, otp } = req.body || {};
    if (!phoneNumber || !otp) {
      return res.status(400).json({ error: "phoneNumber and otp are required" });
    }

    let formattedPhone;
    try {
      formattedPhone = formatPhone(phoneNumber);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }

    if (!isReadyFn()) {
      return res.status(503).json({ error: "WhatsApp client not ready yet" });
    }

    if (otpLimiter.isLimited(formattedPhone)) {
      return res.status(429).json({ error: "Rate limited. Please wait before requesting another OTP." });
    }

    try {
      const client = getClient();
      const isRegistered = await client.isRegisteredUser(formattedPhone);
      if (!isRegistered) {
        return res.status(404).json({ error: "Phone number is not registered on WhatsApp" });
      }

      const message = `🔐 *${brandName} Login Code*\n\nYour one-time password is: *${otp}*\n\nDo not share this with anyone. Valid for 10 minutes.\n\n_${brandName} App_`;
      await client.sendMessage(formattedPhone, message);
      otpLimiter.markSent(formattedPhone);

      console.log(`✅ OTP sent to ******${formattedPhone.slice(4, 8)}`);
      return res.json({ success: true, message: "OTP sent successfully" });
    } catch (err) {
      console.error("❌ Failed to send OTP:", err.message);
      return res.status(500).json({ error: "Failed to send message" });
    }
  });

  app.post("/api/send-instant", apiRateLimiter, authenticate, async (req, res) => {
    const { phoneNumber, message, isCampaign, imagePath, imagePaths, videoPath } = req.body || {};
    if (!phoneNumber || !message) {
      return res.status(400).json({ error: "phoneNumber and message are required" });
    }

    let formattedPhone;
    try {
      formattedPhone = formatPhone(phoneNumber);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }

    if (!isReadyFn()) {
      return res.status(503).json({ error: "WhatsApp client not ready yet" });
    }

    try {
      const client = getClient();
      const isRegistered = await client.isRegisteredUser(formattedPhone);
      if (!isRegistered) {
        return res.status(404).json({ error: "Phone number is not registered on WhatsApp" });
      }

      if (imagePaths && Array.isArray(imagePaths)) {
        for (const p of imagePaths) {
          const safe = resolveSafeMediaPath(p, mediaBaseDir);
          if (!safe) {
            return res.status(400).json({ error: "Invalid media path" });
          }
          if (fs.existsSync(safe)) {
            const media = MessageMedia.fromFilePath(safe);
            await client.sendMessage(formattedPhone, media);
            await new Promise((r) => setTimeout(r, 500));
          }
        }
        await client.sendMessage(formattedPhone, message);
      } else if (videoPath) {
        const safeVideo = resolveSafeMediaPath(videoPath, mediaBaseDir);
        if (!safeVideo) {
          return res.status(400).json({ error: "Invalid video path" });
        }
        if (fs.existsSync(safeVideo)) {
          const media = MessageMedia.fromFilePath(safeVideo);
          await client.sendMessage(formattedPhone, media, { caption: message });
        } else {
          await client.sendMessage(formattedPhone, message);
        }
      } else if (imagePath) {
        const safeImg = resolveSafeMediaPath(imagePath, mediaBaseDir);
        if (!safeImg) {
          return res.status(400).json({ error: "Invalid image path" });
        }
        if (fs.existsSync(safeImg)) {
          const media = MessageMedia.fromFilePath(safeImg);
          await client.sendMessage(formattedPhone, media, { caption: message });
        } else {
          await client.sendMessage(formattedPhone, message);
        }
      } else {
        await client.sendMessage(formattedPhone, message);
      }

      if (isCampaign) {
        campaignPhones.add(String(phoneNumber).replace(/\D/g, "").slice(-10));
      }

      return res.json({ success: true, message: "Message sent" });
    } catch (err) {
      console.error("❌ Failed to send instant message:", err.message);
      return res.status(500).json({ error: "Failed to send message" });
    }
  });

  app.post("/api/send-document", apiRateLimiter, authenticate, async (req, res) => {
    const checked = validateDocumentPayload(req.body);
    if (!checked.ok) {
      return res.status(checked.status).json({ error: checked.error });
    }

    if (!isReadyFn()) {
      return res.status(503).json({ error: "WhatsApp client not ready yet" });
    }

    try {
      const client = getClient();
      const isRegistered = await client.isRegisteredUser(checked.formattedPhone);
      if (!isRegistered) {
        return res.status(404).json({ error: "Phone number is not registered on WhatsApp" });
      }

      const media = new MessageMedia("application/pdf", checked.cleanBase64, checked.filename);
      const sendOptions = checked.caption
        ? { caption: checked.caption, sendMediaAsDocument: true }
        : { sendMediaAsDocument: true };
      await client.sendMessage(checked.formattedPhone, media, sendOptions);

      console.log(`✅ Document (${checked.filename}) sent to ******${checked.formattedPhone.slice(4, 8)}`);
      return res.json({ sent: true, success: true });
    } catch (err) {
      console.error("❌ Failed to send document:", err.message);
      return res.status(500).json({ error: "Failed to send document" });
    }
  });

  app.post("/api/bulk-message", apiRateLimiter, authenticate, async (req, res) => {
    const { phoneNumbers, message, templateType } = req.body || {};
    if (!phoneNumbers || !Array.isArray(phoneNumbers) || phoneNumbers.length === 0) {
      return res.status(400).json({ error: "phoneNumbers array is required" });
    }
    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "message is required" });
    }

    const rows = phoneNumbers.map((phone) => ({
      phone_number: phone,
      message,
      template_type: templateType || "announcement",
      status: "pending",
      created_at: new Date().toISOString(),
    }));

    const { error } = await supabase.from("whatsapp_message_queue").insert(rows);
    if (error) {
      console.error("❌ Failed to queue messages:", error.message);
      return res.status(500).json({ error: "Failed to queue messages" });
    }

    return res.json({
      success: true,
      queued: phoneNumbers.length,
      message: `${phoneNumbers.length} messages queued. Will be sent ~1 per 45 seconds.`,
    });
  });

  return app;
}

// Puppeteer's own Chrome is not installed on this Windows PC ("Could not find Chrome"), so use the
// installed Google Chrome. PUPPETEER_EXECUTABLE_PATH still wins when set.
function findChromeExecutable(env = process.env) {
  if (env.PUPPETEER_EXECUTABLE_PATH) return env.PUPPETEER_EXECUTABLE_PATH;
  if (os.platform() !== "win32") return undefined;
  const candidates = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    `${env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
  ];
  return candidates.find((p) => fs.existsSync(p));
}

function startServer() {
  let config;
  try {
    config = validateServerConfig(process.env);
  } catch (err) {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  }

  const supabase = createClient(config.supabaseUrl, config.serviceKey);
  let isReady = false;

  console.log("⏳ Launching Chrome & loading WhatsApp Web (this takes ~15-20s)...");

  // Same client settings as the server that has been running on this PC: installed Chrome,
  // a desktop user agent, and no remote webVersionCache.
  const client = new Client({
    authStrategy: new LocalAuth({ dataPath: "./whatsapp_session" }),
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    puppeteer: {
      headless: true,
      executablePath: findChromeExecutable(),
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--no-first-run",
        "--no-zygote",
        "--disable-features=IsolateOrigins,site-per-process",
      ],
    },
  });

  async function processQueue() {
    if (!isReady) return;
    try {
      const { data: rows, error } = await supabase
        .from("whatsapp_message_queue")
        .select("*")
        .eq("status", "pending")
        .neq("template_type", "b2b_pitch")
        .order("created_at", { ascending: true })
        .limit(1);

      if (error || !rows?.length) return;
      const row = rows[0];
      const formattedPhone = formatPhone(row.phone_number);

      try {
        const isRegistered = await client.isRegisteredUser(formattedPhone);
        if (!isRegistered) {
          await supabase
            .from("whatsapp_message_queue")
            .update({ status: "failed", error: "not_on_whatsapp", sent_at: new Date().toISOString() })
            .eq("id", row.id);
          return;
        }
        await client.sendMessage(formattedPhone, row.message);
        await supabase
          .from("whatsapp_message_queue")
          .update({ status: "sent", sent_at: new Date().toISOString() })
          .eq("id", row.id);
      } catch (sendErr) {
        await supabase
          .from("whatsapp_message_queue")
          .update({ status: "failed", error: sendErr.message, sent_at: new Date().toISOString() })
          .eq("id", row.id);
      }
    } catch (e) {
      console.error("❌ Worker error:", e.message);
    }
  }

  function startWorkers() {
    setInterval(processQueue, 30 * 1000);
    console.log("🔁 Background worker started (Rent Reminders & App Notifications).");
  }

  client.on("loading_screen", (percent, message) => {
    console.log(`⏳ Loading WhatsApp: ${percent}% - ${message || "syncing..."}`);
  });

  client.on("authenticated", () => {
    console.log("🔑 Session authenticated successfully! Syncing chats...");
  });

  client.on("qr", (qr) => {
    console.log("\n=======================================================");
    console.log("📱 Scan this QR code with your WhatsApp:");
    console.log("   (WhatsApp on phone -> Linked Devices -> Link a Device)");
    console.log("=======================================================\n");
    qrcode.generate(qr, { small: true });
  });

  client.on("ready", () => {
    isReady = true;
    console.log("✅ WhatsApp Client is READY! Session saved.");
    startWorkers();
  });

  client.on("auth_failure", (msg) => {
    console.error("❌ AUTH FAILURE:", msg);
    isReady = false;
  });

  client.on("disconnected", (reason) => {
    isReady = false;
    console.error("🚨 CRITICAL: WhatsApp disconnected!", reason);
  });

  // Windows sometimes holds session files open while whatsapp-web.js cleans up (EBUSY).
  // That must not kill the server that delivers every OTP.
  process.on("uncaughtException", (err) => {
    if (err && err.message && err.message.includes("EBUSY")) {
      console.warn("⚠️ Non-fatal Windows file lock notice (EBUSY):", err.message);
      return;
    }
    console.error("Uncaught Exception:", err);
  });
  process.on("unhandledRejection", (reason) => {
    console.error("Unhandled Rejection:", reason);
  });

  client.initialize();

  const app = createApp({
    serverSecret: config.serverSecret,
    supabase,
    getClient: () => client,
    isReadyFn: () => isReady,
    otpCooldownMs: config.otpCooldownMs,
    brandName: config.brandName,
  });

  app.listen(config.port, () => {
    console.log(`🚀 PG Buddy WhatsApp Server running on port ${config.port}`);
  });
}

if (require.main === module) {
  startServer();
}

module.exports = {
  MAX_DOCUMENT_BYTES,
  DOCUMENT_FILENAME_REGEX,
  validateServerConfig,
  timingSafeEqualStr,
  formatPhone,
  resolveSafeMediaPath,
  validateDocumentPayload,
  createOtpLimiter,
  createAuthenticateMiddleware,
  createApp,
  startServer,
};
