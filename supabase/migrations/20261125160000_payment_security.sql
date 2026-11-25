-- Payment security (audit of 25 Nov 2026). Every attack below was reproduced on the live database as
-- the real roles, in a transaction that was always rolled back (scripts/security/payment-attacks.sql):
--
--   A1  any signed-in user (even a tenant of another PG) could save their own UPI as the "PG-specific"
--       payment details of any PG; that PG's tenants were then shown the attacker's UPI to pay rent to.
--   O2  an owner could file payment details under another owner's name.
--   A5  anyone signed in could write fake entries ("Payment approved ...") into any PG's audit log, and
--       public.log_audit() let even signed-out callers do it under any user's name.
--   V1  an owner could set their own subscription to Enterprise until 2099 without paying.
--   V2  a paid rent record could be deleted, and V4/V5 neither that nor any change of UPI/bank details
--       left a trace in the audit log.
--   N3  signed-out callers could list pending referrals, including the e-mail address of the friend.
-- What was already safe (and still is): tenants cannot change status/amount, insert or delete payments;
-- other owners, staff without the manager/accountant role and signed-out callers cannot change payments.

-- 1. Payment details: a row always belongs to the owner of the PG it is for. Enforced by a trigger so it
--    also holds for the service role and any future policy.
CREATE OR REPLACE FUNCTION public.guard_payment_info_owner()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _property_owner uuid;
BEGIN
  IF NEW.owner_id IS NULL THEN
    RAISE EXCEPTION 'Payment details must belong to an owner' USING ERRCODE = '23502';
  END IF;
  IF NEW.property_id IS NOT NULL THEN
    SELECT owner_id INTO _property_owner FROM public.properties WHERE id = NEW.property_id;
    IF _property_owner IS DISTINCT FROM NEW.owner_id THEN
      RAISE EXCEPTION 'Payment details for a PG can only be set by the owner of that PG' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_payment_info_owner ON public.payment_info;
CREATE TRIGGER guard_payment_info_owner
  BEFORE INSERT OR UPDATE ON public.payment_info
  FOR EACH ROW EXECUTE FUNCTION public.guard_payment_info_owner();

DROP POLICY IF EXISTS "Owners can manage payment info" ON public.payment_info;
DROP POLICY IF EXISTS "Tenants and staff can view payment info" ON public.payment_info;
DROP POLICY IF EXISTS "Tenants can view payment info for their property" ON public.payment_info;
DROP POLICY IF EXISTS "payment_info_owner_select" ON public.payment_info;
DROP POLICY IF EXISTS "payment_info_owner_insert" ON public.payment_info;
DROP POLICY IF EXISTS "payment_info_owner_update" ON public.payment_info;
DROP POLICY IF EXISTS "payment_info_owner_delete" ON public.payment_info;
DROP POLICY IF EXISTS "payment_info_tenant_select" ON public.payment_info;
DROP POLICY IF EXISTS "payment_info_staff_select" ON public.payment_info;

-- Only the owner changes their payment details (not staff: these decide where rent money goes).
CREATE POLICY "payment_info_owner_select" ON public.payment_info FOR SELECT TO authenticated
  USING (owner_id = auth.uid());
CREATE POLICY "payment_info_owner_insert" ON public.payment_info FOR INSERT TO authenticated
  WITH CHECK (owner_id = auth.uid());
CREATE POLICY "payment_info_owner_update" ON public.payment_info FOR UPDATE TO authenticated
  USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());
CREATE POLICY "payment_info_owner_delete" ON public.payment_info FOR DELETE TO authenticated
  USING (owner_id = auth.uid());

-- A tenant sees only the details of the owner of the PG they live in: that PG's own row or the owner's default.
CREATE POLICY "payment_info_tenant_select" ON public.payment_info FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1
    FROM public.tenant_assignments ta
    JOIN public.properties p ON p.id = ta.property_id
    WHERE ta.tenant_id = auth.uid()
      AND ta.is_active
      AND p.owner_id = payment_info.owner_id
      AND (payment_info.property_id IS NULL OR payment_info.property_id = ta.property_id)
  ));

-- Bank details are for managers and accountants, not every staff member (cleaners, plumbers ...).
CREATE POLICY "payment_info_staff_select" ON public.payment_info FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1
    FROM public.staff_members sm
    WHERE sm.staff_user_id = auth.uid()
      AND sm.status = 'active'
      AND sm.owner_id = payment_info.owner_id
      AND sm.role IN ('manager'::public.staff_role, 'accountant'::public.staff_role)
      AND (sm.property_id IS NULL OR payment_info.property_id IS NULL OR sm.property_id = payment_info.property_id)
  ));

-- 2. Every change of payment details is logged, and the owner is told in the app at once, so a change
--    they did not make is noticed before tenants pay.
CREATE OR REPLACE FUNCTION public.audit_payment_info()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _row public.payment_info;
  _what text;
  _now text;
BEGIN
  IF TG_OP = 'DELETE' THEN _row := OLD; ELSE _row := NEW; END IF;

  IF TG_OP = 'UPDATE' AND (OLD.upi_id, OLD.bank_name, OLD.account_number, OLD.ifsc_code, OLD.account_holder, OLD.qr_code_url)
       IS NOT DISTINCT FROM (NEW.upi_id, NEW.bank_name, NEW.account_number, NEW.ifsc_code, NEW.account_holder, NEW.qr_code_url) THEN
    RETURN NULL; -- nothing tenants see has changed
  END IF;

  _what := CASE TG_OP WHEN 'INSERT' THEN 'added' WHEN 'UPDATE' THEN 'changed' ELSE 'removed' END;

  INSERT INTO public.audit_logs (user_id, action, table_name, record_id, property_id, description, old_data, new_data)
  VALUES (
    COALESCE(auth.uid(), '00000000-0000-0000-0000-000000000000'::uuid),
    TG_OP, 'payment_info', _row.id::text, _row.property_id,
    'Payment details ' || _what || CASE WHEN _row.property_id IS NULL THEN ' (default for all PGs)' ELSE '' END,
    CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) END,
    CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) END
  );

  _now := CASE
    WHEN TG_OP = 'DELETE' THEN 'Tenants no longer see these details.'
    ELSE 'Tenants now see: '
      || COALESCE('UPI ' || NULLIF(NEW.upi_id, ''), 'no UPI')
      || COALESCE(', A/c ending ' || right(NULLIF(NEW.account_number, ''), 4), '')
      || '.'
  END;
  INSERT INTO public.notifications (user_id, title, message, type, metadata)
  VALUES (
    _row.owner_id,
    'Payment details ' || _what,
    'Your rent payment details were ' || _what || '. ' || _now || ' If you did not do this, contact support immediately.',
    'security',
    jsonb_build_object('table', 'payment_info', 'record_id', _row.id, 'property_id', _row.property_id, 'changed_by', auth.uid())
  );
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_audit_payment_info ON public.payment_info;
CREATE TRIGGER trg_audit_payment_info
  AFTER INSERT OR UPDATE OR DELETE ON public.payment_info
  FOR EACH ROW EXECUTE FUNCTION public.audit_payment_info();

-- 3. Subscriptions are written only by the payment-verification server code (service role), never by the
--    app: the old ALL policy let an owner give themselves any plan.
DROP POLICY IF EXISTS "System can manage subscriptions" ON public.subscriptions;

-- 4. The audit log is written only by the database triggers (SECURITY DEFINER) and the server.
DROP POLICY IF EXISTS "System can insert audit logs" ON public.audit_logs;
REVOKE ALL ON FUNCTION public.log_audit(uuid, text, text, text, uuid, text, jsonb, jsonb) FROM PUBLIC, anon, authenticated;

-- 5. Rent payments: a paid record cannot be deleted (set it back to pending first if it was marked paid by
--    mistake; both steps are logged), and every deletion is logged with the full row.
CREATE OR REPLACE FUNCTION public.guard_paid_rent_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NOT NULL AND OLD.status = 'paid' THEN
    RAISE EXCEPTION 'A paid payment cannot be deleted. If it was marked paid by mistake, change its status first.'
      USING ERRCODE = '42501';
  END IF;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS guard_paid_rent_delete ON public.rent_payments;
CREATE TRIGGER guard_paid_rent_delete
  BEFORE DELETE ON public.rent_payments
  FOR EACH ROW EXECUTE FUNCTION public.guard_paid_rent_delete();

CREATE OR REPLACE FUNCTION public.audit_rent_payments()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _desc text;
  _user_id uuid := COALESCE(auth.uid(), '00000000-0000-0000-0000-000000000000'::uuid);
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO audit_logs (user_id, action, table_name, record_id, property_id, description, new_data)
    VALUES (_user_id, 'INSERT', 'rent_payments', NEW.id::text, NEW.property_id, 'Rent payment created for ' || NEW.month, to_jsonb(NEW));
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    IF OLD.status IS DISTINCT FROM NEW.status AND NEW.status = 'paid' AND NEW.approved_by IS NOT NULL THEN
      _desc := 'Payment approved and marked paid for ' || NEW.month;
    ELSIF OLD.status IS DISTINCT FROM NEW.status THEN
      _desc := 'Payment status changed from ' || COALESCE(OLD.status, '-') || ' to ' || COALESCE(NEW.status, '-') || ' for ' || NEW.month;
    ELSIF OLD.amount IS DISTINCT FROM NEW.amount THEN
      _desc := 'Payment amount changed from Rs. ' || COALESCE(OLD.amount::text, '-') || ' to Rs. ' || COALESCE(NEW.amount::text, '-') || ' for ' || NEW.month;
    ELSIF OLD.proof_url IS NOT NULL AND NEW.proof_url IS NULL THEN
      _desc := 'Payment proof rejected for ' || NEW.month;
    ELSIF OLD.proof_url IS DISTINCT FROM NEW.proof_url AND NEW.proof_url IS NOT NULL THEN
      _desc := 'Payment proof submitted for ' || NEW.month;
    ELSE
      _desc := 'Payment record updated for ' || NEW.month;
    END IF;
    INSERT INTO audit_logs (user_id, action, table_name, record_id, property_id, description, old_data, new_data)
    VALUES (_user_id, 'UPDATE', 'rent_payments', NEW.id::text, NEW.property_id, _desc, to_jsonb(OLD), to_jsonb(NEW));
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    INSERT INTO audit_logs (user_id, action, table_name, record_id, property_id, description, old_data)
    VALUES (_user_id, 'DELETE', 'rent_payments', OLD.id::text, OLD.property_id,
            'Rent payment deleted for ' || OLD.month || ' (' || COALESCE(OLD.status, '-') || ', Rs. ' || COALESCE(OLD.amount::text, '-') || ')',
            to_jsonb(OLD));
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_audit_rent_payments ON public.rent_payments;
CREATE TRIGGER trg_audit_rent_payments
  AFTER INSERT OR UPDATE OR DELETE ON public.rent_payments
  FOR EACH ROW EXECUTE FUNCTION public.audit_rent_payments();

-- 6. Referrals are only visible to the person who made them (the app never looks one up signed out).
DROP POLICY IF EXISTS "Anyone can view referral by code" ON public.referrals;

-- 7. Defence in depth: the app never truncates tables or creates triggers or foreign keys on payment tables.
REVOKE TRUNCATE, TRIGGER, REFERENCES ON public.payment_info, public.rent_payments, public.rent_history,
  public.utility_bills, public.mess_payments, public.subscriptions, public.subscription_plans, public.audit_logs
  FROM anon, authenticated;
