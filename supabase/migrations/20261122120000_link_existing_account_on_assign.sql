-- Link a tenant's room assignment and rent records to their EXISTING account when the owner
-- adds or edits them.
--
-- Before this, rows were linked only when the tenant's account was first created
-- (link_tenant_assignment_on_signup, AFTER INSERT ON profiles). If the tenant already had an
-- account and the owner skipped "search" in the add dialog, tenant_id stayed NULL forever:
-- the owner saw "Pending Registration" and the tenant's dashboard stayed empty.
--
-- Rules (same matching as signup linking and find_user_by_phone):
--   * only when tenant_id IS NULL; an existing link is never overwritten
--   * phone: last 10 digits, against auth.users.phone and profiles.phone; exactly one account
--   * two accounts share the number: leave the row pending rather than guess, because a wrong
--     link shows one person's room and dues to a stranger
--   * no phone match: email, case-insensitive, exactly one account; blank never matches
--   * no match: the row stays pending and signup linking still picks it up later
--
-- Tested in src/test/link-tenant-on-assign.test.ts (PGlite).

CREATE OR REPLACE FUNCTION public.link_tenant_row_to_existing_account()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  clean_phone text;
  clean_email text;
  found uuid[];
BEGIN
  IF NEW.tenant_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  clean_phone := RIGHT(REGEXP_REPLACE(COALESCE(NEW.tenant_phone, ''), '\D', '', 'g'), 10);
  IF LENGTH(clean_phone) = 10 THEN
    SELECT array_agg(DISTINCT m.user_id) INTO found
    FROM (
      SELECT u.id AS user_id FROM auth.users u
      WHERE u.phone IS NOT NULL
        AND RIGHT(REGEXP_REPLACE(u.phone, '\D', '', 'g'), 10) = clean_phone
      UNION
      SELECT p.user_id FROM public.profiles p
      WHERE p.phone IS NOT NULL
        AND RIGHT(REGEXP_REPLACE(p.phone, '\D', '', 'g'), 10) = clean_phone
    ) m;

    IF COALESCE(array_length(found, 1), 0) = 1 THEN
      NEW.tenant_id := found[1];
      RETURN NEW;
    ELSIF COALESCE(array_length(found, 1), 0) > 1 THEN
      RETURN NEW; -- ambiguous: don't guess
    END IF;
  END IF;

  clean_email := LOWER(TRIM(COALESCE(NEW.tenant_email, '')));
  IF clean_email <> '' THEN
    SELECT array_agg(u.id) INTO found
    FROM auth.users u
    WHERE u.email IS NOT NULL AND LOWER(TRIM(u.email)) = clean_email;

    IF COALESCE(array_length(found, 1), 0) = 1 THEN
      NEW.tenant_id := found[1];
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS link_existing_account_on_assignment ON public.tenant_assignments;
CREATE TRIGGER link_existing_account_on_assignment
  BEFORE INSERT OR UPDATE OF tenant_phone, tenant_email ON public.tenant_assignments
  FOR EACH ROW EXECUTE FUNCTION public.link_tenant_row_to_existing_account();

DROP TRIGGER IF EXISTS link_existing_account_on_rent_payment ON public.rent_payments;
CREATE TRIGGER link_existing_account_on_rent_payment
  BEFORE INSERT OR UPDATE OF tenant_phone, tenant_email ON public.rent_payments
  FOR EACH ROW EXECUTE FUNCTION public.link_tenant_row_to_existing_account();

-- One-time fix-up for rows that got stuck before this migration. Setting tenant_phone to itself
-- fires the triggers above, so stuck rows are linked by exactly the same rules. Only rows with
-- something to match on are touched.
UPDATE public.tenant_assignments
SET tenant_phone = tenant_phone
WHERE tenant_id IS NULL
  AND (COALESCE(tenant_phone, '') <> '' OR COALESCE(TRIM(tenant_email), '') <> '');

UPDATE public.rent_payments
SET tenant_phone = tenant_phone
WHERE tenant_id IS NULL
  AND (COALESCE(tenant_phone, '') <> '' OR COALESCE(TRIM(tenant_email), '') <> '');
