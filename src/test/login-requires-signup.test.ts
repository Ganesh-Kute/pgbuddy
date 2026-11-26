// @vitest-environment node
//
// "Log in" with a number nobody signed up or invited must not create an account (Ganesh's friend,
// 26 Nov 2026: a role-less account and the "Finish setting up your account" screen). Runs the real
// hook SQL in PGlite against the event shape Supabase sends to a Before User Created hook.
import { describe, it, expect, beforeAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "fs";
import path from "path";

const HOOK = path.resolve(__dirname, "../../supabase/migrations/20261126170000_login_requires_signup_or_invite.sql");

const SCHEMA = `
  CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE supabase_auth_admin;
  CREATE TABLE public.tenant_assignments (id serial, tenant_id uuid, tenant_phone text, is_active boolean DEFAULT true);
  CREATE TABLE public.rent_payments (id serial, tenant_id uuid, tenant_phone text);
  CREATE TABLE public.tenant_invitations (id serial, tenant_phone text, status text, expires_at timestamptz);
  CREATE TABLE public.staff_members (id serial, staff_user_id uuid, invited_phone text, status text);
`;
const T = { timeout: 60_000 };
let db: PGlite;

/** The event Supabase sends: the user about to be created (phone without "+", metadata from Sign up). */
const event = (phone: string, metadata: Record<string, unknown> = {}) =>
  JSON.stringify({
    metadata: { uuid: "00000000-0000-0000-0000-000000000000", time: "2026-11-26T00:00:00Z", name: "before-user-created" },
    user: { id: "11111111-1111-1111-1111-111111111111", aud: "authenticated", phone, email: "", user_metadata: metadata, app_metadata: { provider: "phone" } },
  });

async function decide(phone: string, metadata: Record<string, unknown> = {}) {
  const r = await db.query<{ out: { error?: { http_code: number; message: string } } }>(
    "SELECT public.hook_before_user_created($1::jsonb) AS out",
    [event(phone, metadata)],
  );
  return r.rows[0].out;
}
const allowed = async (phone: string, metadata?: Record<string, unknown>) => (await decide(phone, metadata)).error === undefined;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SCHEMA);
  await db.exec(readFileSync(HOOK, "utf8"));
}, 60_000);

describe("a new number tapping 'Log in'", () => {
  it("is refused with a message telling them to sign up (the friend's case)", T, async () => {
    expect(await decide("919999902170")).toEqual({
      error: { http_code: 403, message: "No account found for this number. Please sign up first." },
    });
  });

  it("Sign up is always allowed: the form sends the chosen role", T, async () => {
    expect(await allowed("919999902170", { role: "owner", full_name: "A" })).toBe(true);
    expect(await allowed("919999902170", { role: "tenant" })).toBe(true);
    expect(await allowed("919999902170", { role: "admin" })).toBe(false); // only the two real roles
  });
});

describe("invited people still log in without signing up", () => {
  it("a tenant the owner added (room assignment), whatever the number's format", T, async () => {
    await db.exec(`INSERT INTO tenant_assignments (tenant_id, tenant_phone) VALUES (NULL, '+91 98111-22233')`);
    expect(await allowed("919811122233")).toBe(true);
  });

  it("a tenant with only a pending rent record", T, async () => {
    await db.exec(`INSERT INTO rent_payments (tenant_id, tenant_phone) VALUES (NULL, '9822233344')`);
    expect(await allowed("919822233344")).toBe(true);
  });

  it("a pending, unexpired tenant invitation; not a cancelled or expired one", T, async () => {
    await db.exec(`INSERT INTO tenant_invitations (tenant_phone, status, expires_at) VALUES
      ('9833344455', 'pending', now() + interval '7 days'),
      ('9844455566', 'cancelled', now() + interval '7 days'),
      ('9855566677', 'pending', now() - interval '1 day')`);
    expect(await allowed("919833344455")).toBe(true);
    expect(await allowed("919844455566")).toBe(false);
    expect(await allowed("919855566677")).toBe(false);
  });

  it("a pending staff invitation", T, async () => {
    await db.exec(`INSERT INTO staff_members (staff_user_id, invited_phone, status) VALUES (NULL, '+919866677788', 'pending')`);
    expect(await allowed("919866677788")).toBe(true);
  });

  it("a moved-out assignment or one already linked to an account does not count", T, async () => {
    await db.exec(`INSERT INTO tenant_assignments (tenant_id, tenant_phone, is_active) VALUES
      (NULL, '9877788899', false),
      ('22222222-2222-2222-2222-222222222222', '9888899900', true)`);
    expect(await allowed("919877788899")).toBe(false);
    expect(await allowed("919888899900")).toBe(false);
  });
});

describe("safety", () => {
  it("accounts without a phone are not restricted (the app signs in by phone)", T, async () => {
    expect(await allowed("")).toBe(true);
  });

  it("only the auth service may call it, so nobody can ask 'is this number invited?'", T, async () => {
    await db.exec("SET ROLE authenticated");
    await expect(db.query("SELECT public.hook_before_user_created($1::jsonb)", [event("919811122233")])).rejects.toThrow(/permission denied/);
    await db.exec("RESET ROLE");
  });

  it("fails open: if a table it reads is broken, new tenants are still let in", T, async () => {
    const broken = new PGlite();
    await broken.exec("CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE supabase_auth_admin;");
    await broken.exec(readFileSync(HOOK, "utf8")); // none of the tables exist
    const r = await broken.query<{ out: unknown }>("SELECT public.hook_before_user_created($1::jsonb) AS out", [event("919811122233")]);
    expect(r.rows[0].out).toEqual({});
  });
});
