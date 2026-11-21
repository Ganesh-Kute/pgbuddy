-- Roles hardening (FIX_PLAN Track A).
--
-- The dashboard redirect bug: a signed-in user with no `user_roles` row was bounced on every sidebar
-- click. Rows go missing because the role is only written by `handle_new_user_role`, and only when the
-- signup carried `role` metadata. "Log in" with a new number creates an account without it, and since
-- 20260308122645 removed the client INSERT policy, such an account had no way to get a role at all.
--
-- This migration is idempotent: every statement can run twice without changing the result.

-- 1. Users still cannot write their own role directly (re-asserted; 20260308122645 already dropped it).
DROP POLICY IF EXISTS "Users can insert their own role on signup" ON public.user_roles;

-- 2. Backfill accounts that have no role, from the strongest evidence first.
--    a) They own a property: owner.
INSERT INTO public.user_roles (user_id, role)
SELECT DISTINCT p.owner_id, 'owner'::public.app_role
FROM public.properties p
WHERE NOT EXISTS (SELECT 1 FROM public.user_roles r WHERE r.user_id = p.owner_id)
ON CONFLICT (user_id, role) DO NOTHING;

--    b) They are assigned to a bed: tenant.
INSERT INTO public.user_roles (user_id, role)
SELECT DISTINCT ta.tenant_id, 'tenant'::public.app_role
FROM public.tenant_assignments ta
WHERE ta.tenant_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM public.user_roles r WHERE r.user_id = ta.tenant_id)
ON CONFLICT (user_id, role) DO NOTHING;

--    c) Otherwise, the role they chose at signup.
INSERT INTO public.user_roles (user_id, role)
SELECT u.id, (u.raw_user_meta_data->>'role')::public.app_role
FROM auth.users u
WHERE u.raw_user_meta_data->>'role' IN ('owner', 'tenant')
  AND NOT EXISTS (SELECT 1 FROM public.user_roles r WHERE r.user_id = u.id)
ON CONFLICT (user_id, role) DO NOTHING;

-- 3. The one way a role-less account picks a role: once, server-side. It never adds a second role and
--    never changes one, so it cannot be used to turn a tenant into an owner.
CREATE OR REPLACE FUNCTION public.claim_initial_role(_role public.app_role)
RETURNS public.app_role
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _uid uuid := auth.uid();
  _existing public.app_role;
BEGIN
  IF _uid IS NULL THEN
    RAISE EXCEPTION 'not signed in' USING ERRCODE = '28000';
  END IF;

  -- Serialise concurrent calls for the same user (a double tap on the button).
  PERFORM pg_advisory_xact_lock(hashtext('claim_initial_role:' || _uid::text));

  SELECT role INTO _existing FROM public.user_roles WHERE user_id = _uid
  ORDER BY (role = 'owner') DESC LIMIT 1;
  IF _existing IS NOT NULL THEN
    RETURN _existing;
  END IF;

  INSERT INTO public.user_roles (user_id, role) VALUES (_uid, _role);
  RETURN _role;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_initial_role(public.app_role) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.claim_initial_role(public.app_role) TO authenticated;

-- 4. S6: an email invitation links staff only to an account whose email is confirmed. Before this,
--    anyone who signed up with the invited address (unconfirmed) became that owner's staff.
--    Phone invitations are linked by link_staff_on_signup, where the phone is proven by the OTP.
CREATE OR REPLACE FUNCTION public.claim_staff_invitation()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _user_id uuid := auth.uid();
  _email text;
BEGIN
  IF _user_id IS NULL THEN RETURN; END IF;

  SELECT email INTO _email FROM auth.users
  WHERE id = _user_id AND email_confirmed_at IS NOT NULL;
  IF _email IS NULL THEN RETURN; END IF;

  UPDATE public.staff_members
  SET staff_user_id = _user_id, status = 'active', updated_at = now()
  WHERE lower(invited_email) = lower(_email)
    AND status = 'pending'
    AND staff_user_id IS NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_staff_invitation() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.claim_staff_invitation() TO authenticated;
