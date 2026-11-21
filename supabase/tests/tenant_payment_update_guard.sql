-- Test for migrations/20261121130000_tenant_payment_update_guard.sql against a plain Postgres 15+.
-- It builds a minimal Supabase stand-in (roles, auth.uid(), the payment tables and their live RLS
-- policies), applies the migration, and runs every case. Every line printed must start with PASS.
--
--   createdb guard_test
--   psql -d guard_test -f supabase/tests/tenant_payment_update_guard.sql | grep -E 'PASS|FAIL'
--   dropdb guard_test
--
-- Roles are cluster-wide, so on a reused cluster "role already exists" errors at the top are fine.

-- Minimal Supabase stand-in for testing 20261121130000_tenant_payment_update_guard.sql
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;

CREATE TYPE public.staff_role AS ENUM ('manager', 'accountant', 'caretaker');
CREATE TABLE public.properties (id uuid PRIMARY KEY, owner_id uuid NOT NULL, is_active boolean DEFAULT true);
CREATE TABLE public.staff_members (staff_user_id uuid, owner_id uuid, property_id uuid, role public.staff_role, status text);
CREATE TABLE public.rent_payments (
  id uuid PRIMARY KEY, property_id uuid, room_id uuid, tenant_id uuid, tenant_email text, tenant_phone text,
  amount numeric, month text, status text, payment_date timestamptz, payment_method text, payment_type text,
  approved_by uuid, proof_url text, proof_uploaded_at timestamptz, transaction_id text, tenant_name text,
  created_at timestamptz DEFAULT now());
CREATE TABLE public.utility_bills (
  id uuid PRIMARY KEY, property_id uuid, room_id uuid, tenant_id uuid, amount numeric, bill_month text, bill_type text,
  status text, proof_url text, proof_uploaded_at timestamptz, created_at timestamptz DEFAULT now());

-- copied from 20260308191309
CREATE FUNCTION public.get_staff_property_ids(_user_id uuid) RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT p.id FROM properties p WHERE p.owner_id IN (
    SELECT owner_id FROM staff_members WHERE staff_user_id = _user_id AND status = 'active' AND property_id IS NULL)
  UNION
  SELECT sm.property_id FROM staff_members sm WHERE sm.staff_user_id = _user_id AND sm.status = 'active' AND sm.property_id IS NOT NULL $$;
CREATE FUNCTION public.is_staff_of_property(_user_id uuid, _property_id uuid, _roles staff_role[]) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM staff_members WHERE staff_user_id = _user_id AND status = 'active' AND role = ANY(_roles)
    AND (property_id = _property_id OR (property_id IS NULL AND owner_id = (SELECT owner_id FROM properties WHERE id = _property_id)))) $$;

ALTER TABLE public.rent_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.utility_bills ENABLE ROW LEVEL SECURITY;
-- the live policies (from rls-final.py)
CREATE POLICY "Accountant staff can manage payments" ON public.rent_payments FOR ALL TO authenticated
  USING (public.is_staff_of_property(auth.uid(), property_id, ARRAY['manager','accountant']::staff_role[]))
  WITH CHECK (public.is_staff_of_property(auth.uid(), property_id, ARRAY['manager','accountant']::staff_role[]));
CREATE POLICY "Owners can manage rent payments" ON public.rent_payments FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM properties WHERE properties.id = rent_payments.property_id AND properties.owner_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM properties WHERE properties.id = rent_payments.property_id AND properties.owner_id = auth.uid()));
CREATE POLICY "Tenants can view their own payments" ON public.rent_payments FOR SELECT TO authenticated USING (auth.uid() = tenant_id);
CREATE POLICY "Tenants can update their own pending payments" ON public.rent_payments FOR UPDATE TO authenticated
  USING (auth.uid() = tenant_id) WITH CHECK (auth.uid() = tenant_id);
CREATE POLICY "Owners can manage utility bills" ON public.utility_bills FOR ALL TO public
  USING (EXISTS (SELECT 1 FROM properties WHERE properties.id = utility_bills.property_id AND properties.owner_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM properties WHERE properties.id = utility_bills.property_id AND properties.owner_id = auth.uid()));
CREATE POLICY "Tenants can view their utility bills" ON public.utility_bills FOR SELECT TO public USING (auth.uid() = tenant_id);
CREATE POLICY "Tenants can update their utility bills proof" ON public.utility_bills FOR UPDATE TO public
  USING (auth.uid() = tenant_id) WITH CHECK (auth.uid() = tenant_id);
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated, service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO anon, authenticated, service_role;

\ir ../migrations/20261121130000_tenant_payment_update_guard.sql

-- Each case runs as a role with a JWT sub, and prints PASS/FAIL. ON_ERROR_STOP is off on purpose.
\set owner   '''11111111-1111-1111-1111-111111111111'''
\set tenant  '''22222222-2222-2222-2222-222222222222'''
\set acct    '''33333333-3333-3333-3333-333333333333'''
\set care    '''44444444-4444-4444-4444-444444444444'''
\set newbie  '''55555555-5555-5555-5555-555555555555'''

INSERT INTO properties VALUES ('aaaaaaaa-0000-0000-0000-000000000001', :owner, true),
                              ('aaaaaaaa-0000-0000-0000-000000000002', '99999999-9999-9999-9999-999999999999', true);
INSERT INTO staff_members VALUES (:acct, :owner, 'aaaaaaaa-0000-0000-0000-000000000001', 'accountant', 'active'),
                                 (:care, :owner, 'aaaaaaaa-0000-0000-0000-000000000001', 'caretaker', 'active');
INSERT INTO rent_payments (id, property_id, tenant_id, tenant_phone, amount, month, status, payment_type) VALUES
  ('bbbbbbbb-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', :tenant, '9876543210', 8000, '2026-11', 'pending', 'rent'),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000001', NULL, '9123456780', 8000, '2026-11', 'pending', 'rent');
INSERT INTO utility_bills (id, property_id, tenant_id, amount, bill_month, bill_type, status) VALUES
  ('cccccccc-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', :tenant, 450, '2026-11', 'electricity', 'pending');

CREATE FUNCTION pg_temp.try(_who text, _sub uuid, _sql text, _expect_ok boolean, _label text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE n int; ok boolean; msg text := '';
BEGIN
  BEGIN
    EXECUTE format('SET LOCAL ROLE %I', _who);
    PERFORM set_config('request.jwt.claim.sub', coalesce(_sub::text, ''), true);
    EXECUTE _sql; GET DIAGNOSTICS n = ROW_COUNT;
    ok := n > 0; IF NOT ok THEN msg := ' (0 rows: RLS)'; END IF;
    RAISE EXCEPTION 'rollback' USING ERRCODE = 'P0001';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN NULL;
            WHEN OTHERS THEN ok := false; msg := ' (' || SQLERRM || ')';
  END;
  RESET ROLE;
  RETURN (CASE WHEN ok = _expect_ok THEN 'PASS ' ELSE 'FAIL ' END) || _label || msg;
END $$;

SELECT pg_temp.try('authenticated', :tenant, $q$UPDATE rent_payments SET proof_url='x', proof_uploaded_at=now(), transaction_id='UTR1' WHERE id='bbbbbbbb-0000-0000-0000-000000000001'$q$, true,  'tenant attaches proof to own rent');
SELECT pg_temp.try('authenticated', :tenant, $q$UPDATE rent_payments SET status='paid' WHERE id='bbbbbbbb-0000-0000-0000-000000000001'$q$, false, 'tenant marks own rent paid');
SELECT pg_temp.try('authenticated', :tenant, $q$UPDATE rent_payments SET amount=1 WHERE id='bbbbbbbb-0000-0000-0000-000000000001'$q$, false, 'tenant lowers own rent amount');
SELECT pg_temp.try('authenticated', :tenant, $q$UPDATE rent_payments SET proof_url='x', status='paid' WHERE id='bbbbbbbb-0000-0000-0000-000000000001'$q$, false, 'tenant sneaks status in with proof');
SELECT pg_temp.try('authenticated', :tenant, $q$UPDATE rent_payments SET property_id='aaaaaaaa-0000-0000-0000-000000000002' WHERE id='bbbbbbbb-0000-0000-0000-000000000001'$q$, false, 'tenant moves own rent to another property');
SELECT pg_temp.try('authenticated', :tenant, $q$UPDATE utility_bills SET proof_url='x', proof_uploaded_at=now() WHERE id='cccccccc-0000-0000-0000-000000000001'$q$, true,  'tenant attaches proof to own utility bill');
SELECT pg_temp.try('authenticated', :tenant, $q$UPDATE utility_bills SET status='paid' WHERE id='cccccccc-0000-0000-0000-000000000001'$q$, false, 'tenant marks own utility bill paid');
SELECT pg_temp.try('authenticated', :owner,  $q$UPDATE rent_payments SET status='paid', payment_date=now(), approved_by=auth.uid() WHERE id='bbbbbbbb-0000-0000-0000-000000000001'$q$, true, 'owner marks rent paid');
SELECT pg_temp.try('authenticated', :owner,  $q$UPDATE utility_bills SET status='paid' WHERE id='cccccccc-0000-0000-0000-000000000001'$q$, true, 'owner marks utility bill paid');
SELECT pg_temp.try('authenticated', :owner,  $q$UPDATE rent_payments SET proof_url=NULL, proof_uploaded_at=NULL, transaction_id=NULL WHERE id='bbbbbbbb-0000-0000-0000-000000000001'$q$, true, 'owner rejects proof');
SELECT pg_temp.try('authenticated', :acct,   $q$UPDATE rent_payments SET status='paid' WHERE id='bbbbbbbb-0000-0000-0000-000000000001'$q$, true, 'accountant staff marks rent paid');
SELECT pg_temp.try('authenticated', :care,   $q$UPDATE rent_payments SET status='paid' WHERE id='bbbbbbbb-0000-0000-0000-000000000001'$q$, false, 'caretaker staff marks rent paid (RLS)');
SELECT pg_temp.try('service_role',  NULL,    $q$UPDATE rent_payments SET status='paid', payment_method='razorpay' WHERE id='bbbbbbbb-0000-0000-0000-000000000001'$q$, true, 'service role (webhook) marks rent paid');
SELECT pg_temp.try('postgres',      NULL,    $q$UPDATE rent_payments SET amount=9000$q$, true, 'migration / SQL editor bulk update');
-- signup link: a SECURITY DEFINER function running in the new tenant's session
CREATE FUNCTION public.link_test(_uid uuid) RETURNS void LANGUAGE sql SECURITY DEFINER AS
  $$ UPDATE rent_payments SET tenant_id = _uid WHERE tenant_phone = '9123456780' AND tenant_id IS NULL $$;
GRANT EXECUTE ON FUNCTION public.link_test(uuid) TO authenticated;
SELECT pg_temp.try('authenticated', :newbie, $q$SELECT public.link_test(auth.uid())$q$, true, 'signup trigger links unlinked rent to new tenant');
SELECT pg_temp.try('authenticated', :newbie, $q$UPDATE rent_payments SET tenant_id=auth.uid() WHERE id='bbbbbbbb-0000-0000-0000-000000000002'$q$, false, 'tenant claims an unlinked rent row directly (RLS)');
CREATE FUNCTION public.link_bad(_uid uuid) RETURNS void LANGUAGE sql SECURITY DEFINER AS
  $$ UPDATE rent_payments SET tenant_id = _uid, status = 'paid' WHERE tenant_phone = '9123456780' AND tenant_id IS NULL $$;
GRANT EXECUTE ON FUNCTION public.link_bad(uuid) TO authenticated;
SELECT pg_temp.try('authenticated', :newbie, $q$SELECT public.link_bad(auth.uid())$q$, false, 'a definer function in a tenant session cannot also mark it paid');
