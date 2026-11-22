import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../..");

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  ".git",
  ".hive",
  "whatsapp_session",
  ".wwebjs_cache",
]);

const TEXT_EXTS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".mjs",
  ".cjs",
  ".py",
  ".sql",
  ".yml",
  ".yaml",
  ".json",
  ".bat",
  ".sh",
  ".toml",
]);

function walkFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkFiles(full));
    } else if (entry.isFile() && TEXT_EXTS.has(path.extname(entry.name).toLowerCase())) {
      out.push(full);
    }
  }
  return out;
}

function jwtRole(token: string): string | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as { role?: unknown };
    return typeof payload.role === "string" ? payload.role : null;
  } catch {
    return null;
  }
}

const ARCHIVED_MIGRATIONS = [
  "20260318171200_test_pricing.sql",
  "20260318171500_restore_pricing.sql",
  "20260320135200_clear_user_data.sql",
  "20260320141000_assign_business_plan.sql",
  "20260325160000_clear_all_data_again.sql",
  "20260325170000_delete_tenants_only.sql",
  "20260325182000_audit_staff_data.sql",
  "20260325183000_inspect_data.sql",
  "20260325184000_delete_all_staff.sql",
  "20260326060000_clean_all_except_owner.sql",
  "20260326061000_diagnostic.sql",
  "20260326061500_diagnostic2.sql",
  "20260326120000_full_reset.sql",
  "20260326121000_verify_reset.sql",
];

const REMOVED_SCRIPTS = [
  "check_db.js",
  "test_aisensy.mjs",
  "whatsapp-server/check-auth-user.js",
  "whatsapp-server/check-sub.js",
  "whatsapp-server/clean_remaining.js",
  "whatsapp-server/clean_users.js",
  "whatsapp-server/clear-queue.js",
  "whatsapp-server/debug-user-id.js",
  "whatsapp-server/debug_complaint.js",
  "whatsapp-server/delete_users.js",
  "whatsapp-server/delete_users_force.js",
  "whatsapp-server/fix-user-login.js",
  "whatsapp-server/fix_staff.js",
  "whatsapp-server/grant-pro.js",
  "whatsapp-server/grant_business.js",
];

describe("repository security and CI hygiene (Track C)", () => {
  it("contains no hardcoded service_role JWTs, Groq keys, or hardcoded WhatsApp secrets in owned scripts", () => {
    const jwtRe = new RegExp("eyJ[A-Za-z0-9_-]{8,}\\.eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{16,}", "g");
    const groqRe = new RegExp("\\b" + "gsk_" + "[A-Za-z0-9]{20,}\\b");
    const hardWaSecret = "pg_buddy_whatsapp_" + "secret_2024";

    const scanTargets = [
      ...walkFiles(path.join(ROOT, "src")),
      ...walkFiles(path.join(ROOT, "supabase")),
      ...walkFiles(path.join(ROOT, "whatsapp-server")),
      ...walkFiles(path.join(ROOT, ".github")),
      ...fs.readdirSync(ROOT)
        .filter((name) => /\.(?:js|mjs|cjs|py)$/.test(name))
        .map((name) => path.join(ROOT, name)),
    ];

    const serviceRoleHits: string[] = [];
    const groqHits: string[] = [];
    const waSecretHits: string[] = [];

    for (const file of scanTargets) {
      const rel = path.relative(ROOT, file).replace(/\\/g, "/");
      const text = fs.readFileSync(file, "utf8");
      const jwts = text.match(jwtRe) ?? [];
      if (jwts.some((tok) => jwtRole(tok) === "service_role")) {
        serviceRoleHits.push(rel);
      }
      if (groqRe.test(text)) {
        groqHits.push(rel);
      }
      if (
        (rel === "whatsapp-server/kaggle_whatsapp_server.py" || rel === "whatsapp-server/generate-pitches.js") &&
        text.includes(hardWaSecret)
      ) {
        waSecretHits.push(rel);
      }
    }

    expect(serviceRoleHits).toEqual([]);
    expect(groqHits).toEqual([]);
    expect(waSecretHits).toEqual([]);
  });

  it("removes one-off production admin and hardcoded key scripts", () => {
    const present = REMOVED_SCRIPTS.filter((rel) => fs.existsSync(path.join(ROOT, rel)));
    expect(present).toEqual([]);
  });

  // Daily clean-up of old log rows (free plan storage): sent/failed WhatsApp queue rows after 30 days.
  const RETENTION_STATEMENTS: Record<string, string[]> = {
    "20261122150000_storage_limits_and_cleanup.sql": [
      "DELETE FROM public.whatsapp_message_queue\n  WHERE status IN ('sent', 'failed') AND created_at < now() - interval '30 days';",
    ],
  };

  it("keeps supabase/migrations free of destructive reset/diagnostic SQL and archives them in supabase/scripts", () => {
    const migDir = path.join(ROOT, "supabase", "migrations");
    const dangerous: string[] = [];
    for (const file of fs.readdirSync(migDir).filter((f) => f.endsWith(".sql"))) {
      let sql = fs.readFileSync(path.join(migDir, file), "utf8");
      // Scheduled log retention is not a reset: only these exact statements are exempt, so any other
      // DELETE added to the same file still fails this test.
      for (const allowed of RETENTION_STATEMENTS[file] ?? []) sql = sql.replace(allowed, "");
      if (/\bTRUNCATE\s+TABLE\b/i.test(sql) || /\bDELETE\s+FROM\s+(?:auth\.users|public\.)/i.test(sql) || /RAISE\s+NOTICE\s+'---/i.test(sql)) {
        dangerous.push(file);
      }
    }
    expect(dangerous).toEqual([]);

    const missingArchives = ARCHIVED_MIGRATIONS.filter(
      (file) => !fs.existsSync(path.join(ROOT, "supabase", "scripts", file)),
    );
    expect(missingArchives).toEqual([]);
  });

  it("configures CI checks for tsc, lint, tests, and build, and keeps APK build secrets wired", () => {
    const ciPath = path.join(ROOT, ".github", "workflows", "ci.yml");
    expect(fs.existsSync(ciPath)).toBe(true);
    const ci = fs.readFileSync(ciPath, "utf8");
    expect(ci).toContain("push:");
    expect(ci).toContain("pull_request:");
    expect(ci).toContain("tsconfig.app.json");
    expect(ci).toContain("tsconfig.node.json");
    expect(ci).toContain("eslint");
    expect(ci).toContain("npm test");
    expect(ci).toContain("npm run build");

    const apkPath = path.join(ROOT, ".github", "workflows", "build-apk.yml");
    const apk = fs.readFileSync(apkPath, "utf8");
    expect(apk).toContain("secrets.VITE_SUPABASE_URL");
    expect(apk).toContain("secrets.VITE_SUPABASE_PUBLISHABLE_KEY");
  });
});
