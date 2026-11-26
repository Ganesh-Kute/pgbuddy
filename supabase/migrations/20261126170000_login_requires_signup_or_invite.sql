-- "Log in" must not create an account for a number nobody signed up or invited.
--
-- Supabase's phone sign-in creates the account the first time a number verifies a code. So someone who
-- tapped "Log in" instead of "Sign up" got an account with no role and landed on "Finish setting up your
-- account" (Ganesh's friend, +91…2170, 26 Nov 2026).
--
-- This is a Before User Created auth hook (Supabase runs it before inserting a new auth user). A new
-- account is allowed only when:
--   * it comes from Sign up: the form sends the chosen role ("owner" / "tenant") as user metadata, or
--   * the phone number is expected: a pending room assignment or rent record (an owner added the
--     tenant), a pending, unexpired tenant invitation, or a pending staff invitation. These are the
--     rows the existing triggers link on first login, matched the same way (last 10 digits).
-- Anyone else gets "No account found for this number. Please sign up first." and no account is created
-- (Supabase does not send the code either). Existing accounts are unaffected: the hook only runs when an
-- account is about to be created.
--
-- Fails OPEN: an unexpected error lets the account in (with a warning in the Postgres log), so a bug
-- here can never lock out every new tenant. Accounts without a phone are not restricted; the app signs
-- in by phone only.
--
-- SECURITY DEFINER: the pending rows are behind RLS, which the auth service's role does not bypass.
-- Only supabase_auth_admin may execute it, so nobody can use it to ask "is this number invited?".
--
-- Enabled in Auth settings: Hooks > Before User Created >
--   pg-functions://postgres/public/hook_before_user_created
-- Tested in src/test/login-requires-signup.test.ts (PGlite).

CREATE OR REPLACE FUNCTION public.hook_before_user_created(event jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  u jsonb := COALESCE(event->'user', '{}'::jsonb);
  signup_role text := COALESCE(u->'user_metadata'->>'role', u->'raw_user_meta_data'->>'role');
  phone text := COALESCE(u->>'phone', '');
  digits text := RIGHT(REGEXP_REPLACE(phone, '\D', '', 'g'), 10);
BEGIN
  IF signup_role IN ('owner', 'tenant') THEN
    RETURN '{}'::jsonb;
  END IF;

  IF phone = '' THEN
    RETURN '{}'::jsonb;
  END IF;

  IF LENGTH(digits) = 10 AND (
       EXISTS (SELECT 1 FROM public.tenant_assignments
               WHERE tenant_id IS NULL AND COALESCE(is_active, true)
                 AND RIGHT(REGEXP_REPLACE(COALESCE(tenant_phone, ''), '\D', '', 'g'), 10) = digits)
    OR EXISTS (SELECT 1 FROM public.rent_payments
               WHERE tenant_id IS NULL
                 AND RIGHT(REGEXP_REPLACE(COALESCE(tenant_phone, ''), '\D', '', 'g'), 10) = digits)
    OR EXISTS (SELECT 1 FROM public.tenant_invitations
               WHERE status = 'pending' AND (expires_at IS NULL OR expires_at > now())
                 AND RIGHT(REGEXP_REPLACE(COALESCE(tenant_phone, ''), '\D', '', 'g'), 10) = digits)
    OR EXISTS (SELECT 1 FROM public.staff_members
               WHERE staff_user_id IS NULL
                 AND RIGHT(REGEXP_REPLACE(COALESCE(invited_phone, ''), '\D', '', 'g'), 10) = digits)
  ) THEN
    RETURN '{}'::jsonb;
  END IF;

  RETURN jsonb_build_object('error', jsonb_build_object(
    'http_code', 403,
    'message', 'No account found for this number. Please sign up first.'
  ));
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'hook_before_user_created failed open: %', SQLERRM;
  RETURN '{}'::jsonb;
END;
$$;

GRANT USAGE ON SCHEMA public TO supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.hook_before_user_created(jsonb) TO supabase_auth_admin;
REVOKE EXECUTE ON FUNCTION public.hook_before_user_created(jsonb) FROM PUBLIC, anon, authenticated;
