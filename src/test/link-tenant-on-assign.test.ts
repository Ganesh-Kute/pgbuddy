// @vitest-environment node
//
// Database tests for linking a tenant's room assignment and rent records to their account.
// Runs the real migration SQL in PGlite (Postgres compiled to WASM), so no Docker or live DB.
//
// The bug: rows were linked only when the tenant's account was first created (the signup
// trigger on profiles). If the tenant already had an account and the owner skipped "search"
// in the add dialog, tenant_id stayed NULL forever: "Pending Registration" for the owner, an
// empty dashboard for the tenant.

import { describe, it, expect } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { existsSync, readFileSync } from "fs";
import path from "path";

const MIGRATIONS = path.resolve(__dirname, "../../supabase/migrations");
const SIGNUP_LINKING = path.join(MIGRATIONS, "20260325150000_fix_phone_matching.sql");
const FIX = path.join(MIGRATIONS, "20261122120000_link_existing_account_on_assign.sql");
const ROLE_FIX = path.join(MIGRATIONS, "20261122130000_tenant_role_on_link.sql");

// Just enough of the production schema for the linking and role rules.
const BASE_SCHEMA = `
  CREATE SCHEMA auth;
  CREATE TABLE auth.users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    phone text,
    email text,
    raw_user_meta_data jsonb NOT NULL DEFAULT '{}'::jsonb
  );
  CREATE TYPE public.app_role AS ENUM ('owner', 'tenant');
  CREATE TABLE public.user_roles (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    role public.app_role NOT NULL,
    UNIQUE (user_id, role)
  );
  CREATE TABLE public.properties (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id uuid REFERENCES auth.users(id) ON DELETE CASCADE
  );
  CREATE TABLE public.profiles (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
    full_name text,
    phone text
  );
  CREATE TABLE public.tenant_assignments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
    tenant_phone text,
    tenant_email text,
    tenant_name text,
    is_active boolean DEFAULT true
  );
  CREATE TABLE public.rent_payments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
    tenant_phone text,
    tenant_email text,
    amount numeric DEFAULT 0,
    status text DEFAULT 'pending'
  );
`;

async function freshDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(BASE_SCHEMA);
  // The production signup linking, exactly as deployed.
  await db.exec(readFileSync(SIGNUP_LINKING, "utf8"));
  await db.exec(`
    CREATE TRIGGER on_tenant_profile_created_link_assignment
    AFTER INSERT ON public.profiles
    FOR EACH ROW EXECUTE FUNCTION public.link_tenant_assignment_on_signup();
  `);
  return db;
}

// On the old code these files do not exist, so nothing is applied.
async function applyFix(db: PGlite) {
  for (const file of [FIX, ROLE_FIX]) {
    if (existsSync(file)) await db.exec(readFileSync(file, "utf8"));
  }
}

async function dbWithFix() {
  const db = await freshDb();
  await applyFix(db);
  return db;
}

// An account as Supabase creates it: auth user, then profile (which fires signup linking).
async function account(
  db: PGlite,
  opts: { phone?: string | null; email?: string | null; profilePhone?: string | null; signupRole?: string } = {}
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    "INSERT INTO auth.users (phone, email, raw_user_meta_data) VALUES ($1, $2, $3) RETURNING id",
    [opts.phone ?? null, opts.email ?? null, opts.signupRole ? { role: opts.signupRole } : {}]
  );
  const id = rows[0].id;
  const profilePhone = opts.profilePhone !== undefined ? opts.profilePhone : opts.phone ?? null;
  await db.query("INSERT INTO public.profiles (user_id, phone) VALUES ($1, $2)", [id, profilePhone]);
  return id;
}

async function addAssignment(
  db: PGlite,
  cols: { tenant_phone?: string | null; tenant_email?: string | null; tenant_id?: string | null }
): Promise<{ id: string; tenant_id: string | null }> {
  const { rows } = await db.query<{ id: string; tenant_id: string | null }>(
    `INSERT INTO public.tenant_assignments (tenant_phone, tenant_email, tenant_id)
     VALUES ($1, $2, $3) RETURNING id, tenant_id`,
    [cols.tenant_phone ?? null, cols.tenant_email ?? null, cols.tenant_id ?? null]
  );
  return rows[0];
}

async function tenantIdOf(db: PGlite, table: string, id: string) {
  const { rows } = await db.query<{ tenant_id: string | null }>(
    `SELECT tenant_id FROM public.${table} WHERE id = $1`,
    [id]
  );
  return rows[0].tenant_id;
}

const T = { timeout: 30000 };

describe("owner adds a tenant who already has an account (failed before the fix)", () => {
  it("links the assignment by phone the moment it is added", T, async () => {
    const db = await dbWithFix();
    const uid = await account(db, { phone: "918108813284" });
    const row = await addAssignment(db, { tenant_phone: "8108813284" });
    expect(row.tenant_id).toBe(uid);
  });

  it("links rent and deposit records too", T, async () => {
    const db = await dbWithFix();
    const uid = await account(db, { phone: "918108813284" });
    const { rows } = await db.query<{ tenant_id: string | null }>(
      "INSERT INTO public.rent_payments (tenant_phone, amount) VALUES ('8108813284', 6000) RETURNING tenant_id"
    );
    expect(rows[0].tenant_id).toBe(uid);
  });

  it.each(["+91 81088 13284", "08108813284", "91-8108813284", "+918108813284"])(
    "matches however the number is typed: %s",
    async (typed) => {
      const db = await dbWithFix();
      const uid = await account(db, { phone: "918108813284" });
      expect((await addAssignment(db, { tenant_phone: typed })).tenant_id).toBe(uid);
    },
    30000
  );

  it("finds an account whose phone is only on the profile (email signup)", T, async () => {
    const db = await dbWithFix();
    const uid = await account(db, { email: "owner@example.com", profilePhone: "7743843389" });
    expect((await addAssignment(db, { tenant_phone: "7743843389" })).tenant_id).toBe(uid);
  });

  it("links by email when no phone is given, ignoring case and spaces", T, async () => {
    const db = await dbWithFix();
    const uid = await account(db, { email: "Tenant@Example.com" });
    expect((await addAssignment(db, { tenant_email: "  tenant@example.com " })).tenant_id).toBe(uid);
  });

  it("links when the owner corrects the phone of a pending tenant", T, async () => {
    const db = await dbWithFix();
    const uid = await account(db, { phone: "918108813284" });
    const row = await addAssignment(db, { tenant_phone: "9999999999" });
    expect(row.tenant_id).toBeNull();
    await db.query("UPDATE public.tenant_assignments SET tenant_phone = '8108813284' WHERE id = $1", [row.id]);
    expect(await tenantIdOf(db, "tenant_assignments", row.id)).toBe(uid);
  });

  it("links rows that were already stuck when the migration is applied", T, async () => {
    const db = await freshDb();
    const uid = await account(db, { phone: "918108813284" });
    const stuck = await addAssignment(db, { tenant_phone: "8108813284" });
    const { rows } = await db.query<{ id: string }>(
      "INSERT INTO public.rent_payments (tenant_phone) VALUES ('8108813284') RETURNING id"
    );
    expect(stuck.tenant_id).toBeNull(); // the bug, reproduced on the old schema
    await applyFix(db);
    expect(await tenantIdOf(db, "tenant_assignments", stuck.id)).toBe(uid);
    expect(await tenantIdOf(db, "rent_payments", rows[0].id)).toBe(uid);
  });
});

describe("never links the wrong person (guards: true before and after)", () => {
  it("two accounts share the last 10 digits: stays pending", T, async () => {
    const db = await dbWithFix();
    await account(db, { phone: "918108813284" });
    await account(db, { phone: "18108813284" });
    expect((await addAssignment(db, { tenant_phone: "8108813284" })).tenant_id).toBeNull();
  });

  it("ambiguous stuck rows stay pending through the one-time fix-up", T, async () => {
    const db = await freshDb();
    await account(db, { phone: "918108813284" });
    await account(db, { phone: "18108813284" });
    const stuck = await addAssignment(db, { tenant_phone: "8108813284" });
    await applyFix(db);
    expect(await tenantIdOf(db, "tenant_assignments", stuck.id)).toBeNull();
  });

  it("never overwrites an existing link", T, async () => {
    const db = await dbWithFix();
    const a = await account(db, { phone: "918108813284" });
    await account(db, { phone: "917743843389" });
    const row = await addAssignment(db, { tenant_phone: "7743843389", tenant_id: a });
    expect(row.tenant_id).toBe(a);
  });

  it("short numbers and blank emails never match", T, async () => {
    const db = await dbWithFix();
    await account(db, { phone: null, email: "", profilePhone: null });
    await account(db, { phone: "13284" });
    expect((await addAssignment(db, { tenant_phone: "13284", tenant_email: "" })).tenant_id).toBeNull();
    expect((await addAssignment(db, { tenant_phone: "", tenant_email: "   " })).tenant_id).toBeNull();
  });

  it("no account yet: stays pending, then links when the tenant first logs in", T, async () => {
    const db = await dbWithFix();
    const row = await addAssignment(db, { tenant_phone: "8108813284" });
    expect(row.tenant_id).toBeNull();
    const uid = await account(db, { phone: "918108813284" });
    expect(await tenantIdOf(db, "tenant_assignments", row.id)).toBe(uid);
  });
});

// The app reads exactly one role per user (useAuth: user_roles ... maybeSingle()). An account with
// no role is bounced on every sidebar click; an account with two roles gets an error and no role.
async function rolesOf(db: PGlite, uid: string): Promise<string[]> {
  const { rows } = await db.query<{ role: string }>(
    "SELECT role::text AS role FROM public.user_roles WHERE user_id = $1 ORDER BY role",
    [uid]
  );
  return rows.map((r) => r.role);
}

describe("a linked tenant with no role becomes a tenant (failed before the fix)", () => {
  it("owner adds an existing role-less account", T, async () => {
    const db = await dbWithFix();
    const uid = await account(db, { phone: "918108813284" });
    await addAssignment(db, { tenant_phone: "8108813284" });
    expect(await rolesOf(db, uid)).toEqual(["tenant"]);
  });

  it("owner clicked search, so the account was given directly", T, async () => {
    const db = await dbWithFix();
    const uid = await account(db, { phone: "918108813284" });
    await addAssignment(db, { tenant_phone: "8108813284", tenant_id: uid });
    expect(await rolesOf(db, uid)).toEqual(["tenant"]);
  });

  it("owner corrects the phone of a pending tenant", T, async () => {
    const db = await dbWithFix();
    const uid = await account(db, { phone: "918108813284" });
    const row = await addAssignment(db, { tenant_phone: "9999999999" });
    await db.query("UPDATE public.tenant_assignments SET tenant_phone = '8108813284' WHERE id = $1", [row.id]);
    expect(await rolesOf(db, uid)).toEqual(["tenant"]);
  });

  it("tenant logs in for the first time without choosing a role", T, async () => {
    const db = await dbWithFix();
    await addAssignment(db, { tenant_phone: "8108813284" });
    const uid = await account(db, { phone: "918108813284" });
    expect(await rolesOf(db, uid)).toEqual(["tenant"]);
  });

  it("already-linked role-less tenants get the role when the migration runs", T, async () => {
    const db = await freshDb();
    const uid = await account(db, { phone: "918108813284" });
    await addAssignment(db, { tenant_phone: "8108813284", tenant_id: uid });
    expect(await rolesOf(db, uid)).toEqual([]); // the bug, on the old schema
    await applyFix(db);
    expect(await rolesOf(db, uid)).toEqual(["tenant"]);
  });
});

describe("never gives anyone a second or wrong role (guards: true before and after)", () => {
  it("an account that already has a role keeps only that role", T, async () => {
    const db = await dbWithFix();
    const uid = await account(db, { phone: "917743843389" });
    await db.query("INSERT INTO public.user_roles (user_id, role) VALUES ($1, 'owner')", [uid]);
    await addAssignment(db, { tenant_phone: "7743843389" });
    expect(await rolesOf(db, uid)).toEqual(["owner"]);
  });

  it("a role-less account that owns a property is not made a tenant", T, async () => {
    const db = await dbWithFix();
    const uid = await account(db, { phone: "917743843389" });
    await db.query("INSERT INTO public.properties (owner_id) VALUES ($1)", [uid]);
    await addAssignment(db, { tenant_phone: "7743843389" });
    expect(await rolesOf(db, uid)).toEqual([]);
  });

  it("signing up as an owner with a pending tenant row for that number ends with only owner", T, async () => {
    const db = await dbWithFix();
    await addAssignment(db, { tenant_phone: "7743843389" });
    // Supabase order: profile insert (linking) runs before the signup role is written.
    const uid = await account(db, { phone: "917743843389", signupRole: "owner" });
    await db.query(
      "INSERT INTO public.user_roles (user_id, role) VALUES ($1, 'owner') ON CONFLICT DO NOTHING",
      [uid]
    );
    expect(await rolesOf(db, uid)).toEqual(["owner"]);
  });

  it("the same tenant added twice has exactly one role row", T, async () => {
    const db = await dbWithFix();
    const uid = await account(db, { phone: "918108813284" });
    await addAssignment(db, { tenant_phone: "8108813284" });
    await addAssignment(db, { tenant_phone: "8108813284" });
    const roles = await rolesOf(db, uid);
    expect(roles.length).toBeLessThanOrEqual(1);
    expect(roles.filter((r) => r !== "tenant")).toEqual([]);
  });

  it("a pending tenant with no account creates no role", T, async () => {
    const db = await dbWithFix();
    await addAssignment(db, { tenant_phone: "8108813284" });
    const { rows } = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM public.user_roles");
    expect(rows[0].n).toBe(0);
  });
});
