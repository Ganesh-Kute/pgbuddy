-- Give a role-less account the tenant role when a room assignment is linked to it.
--
-- An account gets a role only from signup metadata (handle_new_user_role). A tenant who used
-- "Log in" instead of "Sign up" has none, and a role-less user is bounced on every sidebar click
-- (see 20261121120000_roles_hardening.sql). Linking them to a bed is the same evidence that
-- migration's backfill step (b) uses: they are a tenant.
--
-- Rules:
--   * only accounts with NO role. The app reads one role per user (useAuth ... maybeSingle()),
--     so a second role would break their login. Never add one, never change one.
--   * not if they own a property: that is stronger evidence (owner first, as in roles_hardening).
--   * not if they chose a different role at signup. At signup, linking (profiles insert) runs
--     BEFORE handle_new_user_role writes the chosen role, so the metadata is checked here.
--   * serialised with claim_initial_role() by the same per-user advisory lock.
--
-- Covers every way an assignment gets its account: the owner's search, the link trigger in
-- 20261122120000, and signup linking. It is an AFTER trigger without a column list on purpose:
-- column-specific UPDATE triggers do not fire when a BEFORE trigger sets the column, which is
-- exactly how 20261122120000 links rows.
--
-- Tested in src/test/link-tenant-on-assign.test.ts (PGlite).

CREATE OR REPLACE FUNCTION public.grant_tenant_role_on_link()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  signup_role text;
BEGIN
  IF NEW.tenant_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.tenant_id IS NOT DISTINCT FROM NEW.tenant_id THEN
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('claim_initial_role:' || NEW.tenant_id::text));

  IF EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = NEW.tenant_id) THEN
    RETURN NEW;
  END IF;
  IF EXISTS (SELECT 1 FROM public.properties WHERE owner_id = NEW.tenant_id) THEN
    RETURN NEW;
  END IF;

  SELECT u.raw_user_meta_data->>'role' INTO signup_role FROM auth.users u WHERE u.id = NEW.tenant_id;
  IF COALESCE(signup_role, 'tenant') <> 'tenant' THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.user_roles (user_id, role)
  VALUES (NEW.tenant_id, 'tenant')
  ON CONFLICT (user_id, role) DO NOTHING;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.grant_tenant_role_on_link() FROM PUBLIC;

DROP TRIGGER IF EXISTS grant_tenant_role_on_link ON public.tenant_assignments;
CREATE TRIGGER grant_tenant_role_on_link
  AFTER INSERT OR UPDATE ON public.tenant_assignments
  FOR EACH ROW EXECUTE FUNCTION public.grant_tenant_role_on_link();

-- One-time fix-up: tenants already linked to a bed who still have no role. Same rules as above,
-- and it only inserts, so it writes no audit entries for rows it leaves alone.
INSERT INTO public.user_roles (user_id, role)
SELECT DISTINCT ta.tenant_id, 'tenant'::public.app_role
FROM public.tenant_assignments ta
JOIN auth.users u ON u.id = ta.tenant_id
WHERE NOT EXISTS (SELECT 1 FROM public.user_roles r WHERE r.user_id = ta.tenant_id)
  AND NOT EXISTS (SELECT 1 FROM public.properties p WHERE p.owner_id = ta.tenant_id)
  AND COALESCE(u.raw_user_meta_data->>'role', 'tenant') = 'tenant'
ON CONFLICT (user_id, role) DO NOTHING;
