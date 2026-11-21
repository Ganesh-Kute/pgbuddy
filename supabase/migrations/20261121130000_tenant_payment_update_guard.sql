-- Tenants may attach payment proof to their own rent and utility bills, and nothing else.
--
-- Before this, the policies "Tenants can update their own pending payments" (rent_payments) and
-- "Tenants can update their utility bills proof" (utility_bills) checked only auth.uid() = tenant_id,
-- so a tenant could call the API directly and set status = 'paid', or change the amount or month,
-- on any of their own rows. RLS cannot compare old and new values, so a trigger does it.
--
-- Who is NOT restricted by this trigger (RLS still decides what they may touch):
--   * server code with no user, i.e. the service role (razorpay-webhook, rent-reminders) and
--     migrations: auth.uid() is NULL;
--   * the owner of the row's property;
--   * staff of the row's property (RLS already limits staff writes to the right staff roles).
-- Everyone else, in practice the tenant, may change only the proof columns, plus the one-way link
-- tenant_id NULL -> themselves that link_tenant_assignment_on_signup() makes in their session.

CREATE OR REPLACE FUNCTION public.guard_tenant_payment_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _uid uuid := auth.uid();
  _proof_columns text[] := ARRAY['proof_url', 'proof_uploaded_at', 'transaction_id', 'updated_at'];
BEGIN
  IF _uid IS NULL THEN
    RETURN NEW;
  END IF;

  -- Authorise on the row as it was: moving a row to a property you own does not make it yours.
  IF EXISTS (SELECT 1 FROM public.properties WHERE id = OLD.property_id AND owner_id = _uid)
     OR OLD.property_id IN (SELECT public.get_staff_property_ids(_uid)) THEN
    RETURN NEW;
  END IF;

  IF OLD.tenant_id IS NULL AND NEW.tenant_id = _uid THEN
    -- the signup link; compare the rest as if tenant_id had not changed
    _proof_columns := array_append(_proof_columns, 'tenant_id');
  END IF;

  IF (to_jsonb(NEW) - _proof_columns) IS DISTINCT FROM (to_jsonb(OLD) - _proof_columns) THEN
    RAISE EXCEPTION 'Only payment proof can be changed here. Ask the owner to update the payment.'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_tenant_payment_update() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS guard_tenant_payment_update ON public.rent_payments;
CREATE TRIGGER guard_tenant_payment_update
  BEFORE UPDATE ON public.rent_payments
  FOR EACH ROW EXECUTE FUNCTION public.guard_tenant_payment_update();

DROP TRIGGER IF EXISTS guard_tenant_payment_update ON public.utility_bills;
CREATE TRIGGER guard_tenant_payment_update
  BEFORE UPDATE ON public.utility_bills
  FOR EACH ROW EXECUTE FUNCTION public.guard_tenant_payment_update();
