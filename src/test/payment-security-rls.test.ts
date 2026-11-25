// @vitest-environment node
// Payment security (migration 20261125160000_payment_security.sql), run as real Postgres row-level security
// in PGlite. The schema below is the live one reduced to what the policies touch, with the policies that
// were live before the audit; scripts/security/payment-attacks.sql runs the same attacks on production.
import { beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "fs";
import path from "path";

const MIGRATION = readFileSync(path.resolve(__dirname, "../../supabase/migrations/20261125160000_payment_security.sql"), "utf8");

const BASE = `
  CREATE ROLE authenticated NOLOGIN;
  CREATE ROLE anon NOLOGIN;
  CREATE SCHEMA auth;
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
    $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  GRANT USAGE ON SCHEMA auth TO authenticated, anon;
  GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated, anon;

  CREATE TYPE public.staff_role AS ENUM ('manager', 'accountant', 'caretaker', 'plumber', 'electrician', 'cleaner');
  CREATE TABLE public.properties (id uuid PRIMARY KEY, owner_id uuid NOT NULL, name text NOT NULL DEFAULT 'PG');
  CREATE TABLE public.staff_members (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_id uuid NOT NULL, staff_user_id uuid, property_id uuid,
    status text NOT NULL DEFAULT 'active', role public.staff_role
  );
  CREATE TABLE public.tenant_assignments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, property_id uuid NOT NULL, is_active boolean DEFAULT true
  );
  CREATE TABLE public.payment_info (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), property_id uuid UNIQUE, upi_id text, bank_name text,
    account_number text, ifsc_code text, account_holder text, qr_code_url text, owner_id uuid,
    created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now()
  );
  CREATE TABLE public.audit_logs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, action text NOT NULL, table_name text NOT NULL,
    record_id text, property_id uuid, description text NOT NULL, old_data jsonb, new_data jsonb, created_at timestamptz DEFAULT now()
  );
  CREATE TABLE public.notifications (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, title text NOT NULL, message text NOT NULL,
    type text DEFAULT 'reminder', is_read boolean DEFAULT false, metadata jsonb, created_at timestamptz DEFAULT now()
  );
  CREATE TABLE public.subscription_plans (id uuid PRIMARY KEY, name text NOT NULL, is_active boolean DEFAULT true);
  CREATE TABLE public.subscriptions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL UNIQUE, plan_id uuid NOT NULL,
    status text DEFAULT 'active', current_period_end timestamptz
  );
  CREATE TABLE public.rent_payments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, property_id uuid NOT NULL, amount numeric NOT NULL,
    month text NOT NULL, status text DEFAULT 'pending', approved_by uuid, proof_url text
  );
  CREATE TABLE public.rent_history (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
  CREATE TABLE public.utility_bills (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
  CREATE TABLE public.mess_payments (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
  CREATE TABLE public.referrals (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), referrer_id uuid NOT NULL, referral_code text, referred_email text,
    status text DEFAULT 'pending'
  );

  CREATE FUNCTION public.log_audit(_user_id uuid, _action text, _table_name text, _record_id text, _property_id uuid,
    _description text, _old_data jsonb DEFAULT NULL, _new_data jsonb DEFAULT NULL)
  RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
  BEGIN
    INSERT INTO public.audit_logs (user_id, action, table_name, record_id, property_id, description, old_data, new_data)
    VALUES (_user_id, _action, _table_name, _record_id, _property_id, _description, _old_data, _new_data);
  END $$;

  DO $$ DECLARE t text; BEGIN
    FOREACH t IN ARRAY ARRAY['properties','staff_members','tenant_assignments','payment_info','audit_logs','notifications',
      'subscription_plans','subscriptions','rent_payments','rent_history','utility_bills','mess_payments','referrals'] LOOP
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
      EXECUTE format('GRANT ALL ON public.%I TO anon, authenticated', t);
    END LOOP;
  END $$;
  GRANT EXECUTE ON FUNCTION public.log_audit(uuid, text, text, text, uuid, text, jsonb, jsonb) TO anon, authenticated;

  -- The policies that were live before the audit.
  CREATE POLICY "Anyone can view active properties" ON public.properties FOR SELECT TO authenticated USING (true);
  CREATE POLICY "Owners can manage their properties" ON public.properties FOR ALL TO authenticated USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());
  CREATE POLICY "Staff can view their own membership" ON public.staff_members FOR SELECT TO authenticated
    USING (staff_user_id = auth.uid() OR owner_id = auth.uid());
  CREATE POLICY "Tenants can view their own assignments" ON public.tenant_assignments FOR SELECT TO authenticated USING (tenant_id = auth.uid());
  CREATE POLICY "Owners can manage payment info" ON public.payment_info FOR ALL TO authenticated
    USING ((owner_id = auth.uid()) OR (property_id IN (SELECT id FROM public.properties WHERE owner_id = auth.uid())))
    WITH CHECK ((owner_id = auth.uid()) OR (property_id IN (SELECT id FROM public.properties WHERE owner_id = auth.uid())));
  CREATE POLICY "Tenants can view payment info for their property" ON public.payment_info FOR SELECT TO authenticated
    USING (EXISTS (SELECT 1 FROM public.tenant_assignments WHERE tenant_assignments.property_id = payment_info.property_id
      AND tenant_assignments.tenant_id = auth.uid() AND tenant_assignments.is_active = true));
  CREATE POLICY "Tenants and staff can view payment info" ON public.payment_info FOR SELECT TO authenticated
    USING ((EXISTS (SELECT 1 FROM public.tenant_assignments ta WHERE ta.tenant_id = auth.uid() AND ta.property_id = payment_info.property_id))
      OR (EXISTS (SELECT 1 FROM public.tenant_assignments ta JOIN public.properties p ON p.id = ta.property_id
                  WHERE ta.tenant_id = auth.uid() AND p.owner_id = payment_info.owner_id))
      OR (EXISTS (SELECT 1 FROM public.staff_members sm WHERE sm.staff_user_id = auth.uid() AND sm.status = 'active'
                  AND ((payment_info.property_id IS NULL AND payment_info.owner_id = sm.owner_id) OR sm.property_id = payment_info.property_id))));
  CREATE POLICY "System can insert audit logs" ON public.audit_logs FOR INSERT TO authenticated WITH CHECK (true);
  CREATE POLICY "Owners can view audit logs" ON public.audit_logs FOR SELECT TO authenticated
    USING (EXISTS (SELECT 1 FROM public.properties WHERE properties.id = audit_logs.property_id AND properties.owner_id = auth.uid()));
  CREATE POLICY "Users can view own notifications" ON public.notifications FOR SELECT TO authenticated USING (user_id = auth.uid());
  CREATE POLICY "Anyone can view active plans" ON public.subscription_plans FOR SELECT TO authenticated USING (is_active = true);
  CREATE POLICY "System can manage subscriptions" ON public.subscriptions FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
  CREATE POLICY "Users can view their own subscription" ON public.subscriptions FOR SELECT TO authenticated USING (auth.uid() = user_id);
  CREATE POLICY "Owners can manage rent payments" ON public.rent_payments FOR ALL TO authenticated
    USING (EXISTS (SELECT 1 FROM public.properties WHERE properties.id = rent_payments.property_id AND properties.owner_id = auth.uid()))
    WITH CHECK (EXISTS (SELECT 1 FROM public.properties WHERE properties.id = rent_payments.property_id AND properties.owner_id = auth.uid()));
  CREATE POLICY "Tenants can view their own payments" ON public.rent_payments FOR SELECT TO authenticated USING (auth.uid() = tenant_id);
  CREATE POLICY "Users can manage their own referrals" ON public.referrals FOR ALL TO authenticated USING (auth.uid() = referrer_id) WITH CHECK (auth.uid() = referrer_id);
  CREATE POLICY "Anyone can view referral by code" ON public.referrals FOR SELECT USING (status = 'pending');

  -- The live audit trigger before this migration (INSERT/UPDATE only).
  CREATE FUNCTION public.audit_rent_payments() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
  BEGIN
    INSERT INTO audit_logs (user_id, action, table_name, record_id, property_id, description)
    VALUES (COALESCE(auth.uid(), '00000000-0000-0000-0000-000000000000'::uuid), TG_OP, 'rent_payments', NEW.id::text, NEW.property_id, 'x');
    RETURN NEW;
  END $$;
  CREATE TRIGGER trg_audit_rent_payments AFTER INSERT OR UPDATE ON public.rent_payments FOR EACH ROW EXECUTE FUNCTION public.audit_rent_payments();
`;

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const OWNER = id(1), TENANT = id(2), STRANGER = id(3), OTHER_OWNER = id(4), CLEANER = id(5), MANAGER = id(6);
const PG = id(11), OTHER_PG = id(12), FREE = id(21), ENTERPRISE = id(22), PAID = id(31), PENDING = id(32);

const SEED = `
  INSERT INTO public.properties (id, owner_id) VALUES ('${PG}', '${OWNER}'), ('${OTHER_PG}', '${OTHER_OWNER}');
  INSERT INTO public.tenant_assignments (tenant_id, property_id) VALUES ('${TENANT}', '${PG}');
  INSERT INTO public.staff_members (owner_id, staff_user_id, property_id, role) VALUES
    ('${OWNER}', '${CLEANER}', '${PG}', 'cleaner'), ('${OWNER}', '${MANAGER}', '${PG}', 'manager');
  INSERT INTO public.payment_info (owner_id, property_id, upi_id, account_number) VALUES ('${OWNER}', NULL, 'owner@okaxis', '123456789012');
  INSERT INTO public.subscription_plans (id, name) VALUES ('${FREE}', 'Free'), ('${ENTERPRISE}', 'Enterprise');
  INSERT INTO public.subscriptions (user_id, plan_id) VALUES ('${OWNER}', '${FREE}');
  INSERT INTO public.rent_payments (id, tenant_id, property_id, amount, month, status) VALUES
    ('${PAID}', '${TENANT}', '${PG}', 8000, '2026-11', 'paid'), ('${PENDING}', '${TENANT}', '${PG}', 8000, '2026-12', 'pending');
  INSERT INTO public.referrals (referrer_id, referral_code, referred_email) VALUES ('${OWNER}', 'CODE1', 'friend@example.com');
`;

async function makeDb(withMigration: boolean): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(BASE);
  if (withMigration) await db.exec(MIGRATION);
  await db.exec(SEED);
  return db;
}

/** Run as a signed-in user (or signed out with null); returns null on success or the error message. */
async function as(db: PGlite, user: string | null, sql: string): Promise<{ rows: Record<string, unknown>[]; error: string | null }> {
  await db.exec(`RESET ROLE; SELECT set_config('request.jwt.claim.sub', '${user ?? ""}', false);`);
  await db.exec(user ? "SET ROLE authenticated" : "SET ROLE anon");
  try {
    const res = await db.query<Record<string, unknown>>(sql);
    return { rows: res.rows, error: null };
  } catch (err) {
    return { rows: [], error: err instanceof Error ? err.message : String(err) };
  } finally {
    await db.exec("RESET ROLE");
  }
}

/** What the tenant's pay screen shows: the PG-specific row if there is exactly one, else the owner default. */
async function tenantPayScreen(db: PGlite): Promise<string | null> {
  const pg = await as(db, TENANT, `SELECT upi_id FROM public.payment_info WHERE property_id = '${PG}'`);
  if (pg.rows.length === 1) return pg.rows[0].upi_id as string;
  const def = await as(db, TENANT, `SELECT upi_id FROM public.payment_info WHERE property_id IS NULL AND owner_id = '${OWNER}'`);
  return def.rows.length === 1 ? (def.rows[0].upi_id as string) : null;
}

const plantUpi = `INSERT INTO public.payment_info (owner_id, property_id, upi_id) VALUES ('${STRANGER}', '${PG}', 'fraud@ybl')`;

describe("before the payment security migration (proves the checks below can fail)", () => {
  it("a stranger could plant their UPI and the tenant's pay screen showed it", async () => {
    const db = await makeDb(false);
    expect((await as(db, STRANGER, plantUpi)).error).toBeNull();
    expect(await tenantPayScreen(db)).toBe("fraud@ybl");
  });
});

describe("payment security", () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await makeDb(true);
  }, 60_000);

  it("a stranger cannot plant their UPI on someone else's PG; the tenant keeps seeing the owner's", async () => {
    expect((await as(db, STRANGER, plantUpi)).error).toMatch(/owner of that PG|row-level security/);
    expect(await tenantPayScreen(db)).toBe("owner@okaxis");
  });

  it("another owner cannot file details under this owner's name or for this PG", async () => {
    const underVictimName = await as(db, OTHER_OWNER,
      `INSERT INTO public.payment_info (owner_id, property_id, upi_id) VALUES ('${OWNER}', '${OTHER_PG}', 'x@ybl')`);
    expect(underVictimName.error).not.toBeNull();
    const forVictimPg = await as(db, OTHER_OWNER,
      `INSERT INTO public.payment_info (owner_id, property_id, upi_id) VALUES ('${OTHER_OWNER}', '${PG}', 'x@ybl')`);
    expect(forVictimPg.error).not.toBeNull();
  });

  it("only the owner changes payment details; managers may look, cleaners may not", async () => {
    expect((await as(db, CLEANER, "SELECT upi_id FROM public.payment_info")).rows).toHaveLength(0);
    expect((await as(db, MANAGER, "SELECT upi_id FROM public.payment_info")).rows).toEqual([{ upi_id: "owner@okaxis" }]);
    const managerEdit = await as(db, MANAGER, "UPDATE public.payment_info SET upi_id = 'manager@ybl' RETURNING id");
    expect(managerEdit.rows).toHaveLength(0);
    expect((await as(db, STRANGER, "SELECT upi_id FROM public.payment_info")).rows).toHaveLength(0);
    expect((await as(db, null, "SELECT upi_id FROM public.payment_info")).rows).toHaveLength(0);
  });

  it("the owner can still add PG-specific details and change them; each change is logged and the owner alerted", async () => {
    const add = await as(db, OWNER, `INSERT INTO public.payment_info (owner_id, property_id, upi_id) VALUES ('${OWNER}', '${PG}', 'pg@okaxis')`);
    expect(add.error).toBeNull();
    expect(await tenantPayScreen(db)).toBe("pg@okaxis");
    const change = await as(db, OWNER,
      `UPDATE public.payment_info SET upi_id = 'new@okaxis', account_number = '999988887777' WHERE property_id IS NULL RETURNING id`);
    expect(change.rows).toHaveLength(1);

    // (The seed's own insert is logged too, as the service role; only the owner's two changes are checked here.)
    const logs = await db.query<{ action: string; description: string }>(
      `SELECT action, description FROM public.audit_logs WHERE table_name = 'payment_info' AND user_id = '${OWNER}' ORDER BY action`);
    expect(logs.rows).toEqual([
      { action: "INSERT", description: "Payment details added" },
      { action: "UPDATE", description: "Payment details changed (default for all PGs)" },
    ]);
    const alerts = await as(db, OWNER,
      `SELECT title, message FROM public.notifications WHERE metadata->>'changed_by' = '${OWNER}' ORDER BY created_at`);
    expect(alerts.rows.map((r) => r.title)).toEqual(["Payment details added", "Payment details changed"]);
    expect(alerts.rows[1].message).toContain("UPI new@okaxis");
    expect(alerts.rows[1].message).toContain("A/c ending 7777");
    expect(alerts.rows[1].message).not.toContain("999988887777");
  });

  it("the audit log cannot be forged by app users, directly or through log_audit()", async () => {
    const direct = await as(db, STRANGER,
      `INSERT INTO public.audit_logs (user_id, action, table_name, property_id, description) VALUES ('${OWNER}', 'UPDATE', 'rent_payments', '${PG}', 'Payment approved')`);
    expect(direct.error).toMatch(/row-level security/);
    expect((await as(db, STRANGER, `SELECT public.log_audit('${OWNER}', 'UPDATE', 'rent_payments', 'x', '${PG}', 'forged')`)).error).toMatch(/permission denied/);
    expect((await as(db, null, `SELECT public.log_audit('${OWNER}', 'UPDATE', 'rent_payments', 'x', '${PG}', 'forged')`)).error).toMatch(/permission denied/);
  });

  it("nobody can give themselves a paid plan; the owner can still read theirs", async () => {
    const upgrade = await as(db, OWNER, `UPDATE public.subscriptions SET plan_id = '${ENTERPRISE}' RETURNING id`);
    expect(upgrade.rows).toHaveLength(0);
    const insert = await as(db, STRANGER, `INSERT INTO public.subscriptions (user_id, plan_id) VALUES ('${STRANGER}', '${ENTERPRISE}')`);
    expect(insert.error).toMatch(/row-level security/);
    expect((await as(db, OWNER, "SELECT plan_id FROM public.subscriptions")).rows).toEqual([{ plan_id: FREE }]);
  });

  it("a paid rent record cannot be deleted; deleting a pending one works and is logged", async () => {
    expect((await as(db, OWNER, `DELETE FROM public.rent_payments WHERE id = '${PAID}'`)).error).toMatch(/paid payment cannot be deleted/);
    expect((await as(db, OWNER, `DELETE FROM public.rent_payments WHERE id = '${PENDING}' RETURNING id`)).rows).toHaveLength(1);
    const log = await db.query<{ description: string }>(`SELECT description FROM public.audit_logs WHERE action = 'DELETE' AND record_id = '${PENDING}'`);
    expect(log.rows).toEqual([{ description: "Rent payment deleted for 2026-12 (pending, Rs. 8000)" }]);
  });

  it("signed-out callers cannot list referrals (or the e-mails in them)", async () => {
    expect((await as(db, null, "SELECT referred_email FROM public.referrals")).rows).toHaveLength(0);
    expect((await as(db, OWNER, "SELECT referred_email FROM public.referrals")).rows).toHaveLength(1);
  });
});
