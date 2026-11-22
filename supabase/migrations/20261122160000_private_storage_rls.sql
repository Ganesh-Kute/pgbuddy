-- Private tenant files, readable only by the people they belong to (S-10, S-11).
--
-- Before: the tenant-documents and payment-proofs buckets were public (anyone with a link could open a
-- tenant's ID proof), and their storage policies let ANY signed-in user read, overwrite and delete every
-- file in them. property-photos let any signed-in user upload into or delete from any property.
--
-- After:
--   tenant-documents/<tenant uid>/...         the tenant, and the owner/staff of a property they live in
--   tenant-documents/<assignment id>/...      that assignment's tenant, and the owner/staff of its property
--   payment-proofs/<tenant uid>/...           the tenant, and the owner/staff of a property they live in
--   payment-proofs/utility/<tenant uid>/...   same
--   property-photos/<property id>/...         anyone may view; only that property's owner/staff may change
-- The app reads private files through short-lived signed URLs (src/lib/storage-files.ts), and signing
-- runs the same SELECT policy, so a signed link is only ever made for someone allowed to read the file.

-- Owner of the property, or active staff covering it (all-properties staff or this property).
CREATE OR REPLACE FUNCTION public.can_manage_property(_user uuid, _property uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT _user IS NOT NULL AND _property IS NOT NULL AND (
    EXISTS (SELECT 1 FROM public.properties p WHERE p.id = _property AND p.owner_id = _user)
    OR EXISTS (
      SELECT 1
      FROM public.staff_members sm
      JOIN public.properties p ON p.owner_id = sm.owner_id
      WHERE p.id = _property
        AND sm.staff_user_id = _user
        AND sm.status = 'active'
        AND (sm.property_id IS NULL OR sm.property_id = _property)
    )
  );
$$;

-- Does _user manage a property where the tenant (account _tenant) has or had a room?
CREATE OR REPLACE FUNCTION public.can_manage_tenant(_user uuid, _tenant uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT _user IS NOT NULL AND _tenant IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.tenant_assignments ta
    WHERE ta.tenant_id = _tenant AND public.can_manage_property(_user, ta.property_id)
  );
$$;

-- The one access rule for objects in the two private buckets.
CREATE OR REPLACE FUNCTION public.can_access_tenant_file(_bucket text, _name text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _uid uuid := auth.uid();
  _parts text[] := string_to_array(coalesce(_name, ''), '/');
  _key text;
  _key_id uuid;
  _assignment record;
BEGIN
  IF _uid IS NULL OR array_length(_parts, 1) IS NULL OR array_length(_parts, 1) < 2 THEN
    RETURN false;
  END IF;

  IF _bucket = 'payment-proofs' AND _parts[1] = 'utility' THEN
    IF array_length(_parts, 1) < 3 THEN RETURN false; END IF;
    _key := _parts[2];
  ELSIF _bucket IN ('payment-proofs', 'tenant-documents') THEN
    _key := _parts[1];
  ELSE
    RETURN false;
  END IF;

  -- Not a uuid: no rule matches (and never an error, which would break listing).
  IF _key !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RETURN false;
  END IF;
  _key_id := _key::uuid;

  -- The tenant's own folder.
  IF _key_id = _uid THEN
    RETURN true;
  END IF;

  -- An owner/staff member looking at a tenant's own folder.
  IF public.can_manage_tenant(_uid, _key_id) THEN
    RETURN true;
  END IF;

  -- tenant-documents/<assignment id>/...: uploaded by the owner for that assignment.
  IF _bucket = 'tenant-documents' THEN
    SELECT ta.tenant_id, ta.property_id INTO _assignment
    FROM public.tenant_assignments ta WHERE ta.id = _key_id;
    IF FOUND AND (_assignment.tenant_id = _uid OR public.can_manage_property(_uid, _assignment.property_id)) THEN
      RETURN true;
    END IF;
  END IF;

  RETURN false;
END;
$$;

-- Property photos: the first folder is the property id.
CREATE OR REPLACE FUNCTION public.can_manage_property_photo(_name text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _key text := split_part(coalesce(_name, ''), '/', 1);
BEGIN
  IF _key !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RETURN false;
  END IF;
  RETURN public.can_manage_property(auth.uid(), _key::uuid);
END;
$$;

REVOKE ALL ON FUNCTION public.can_manage_property(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.can_manage_tenant(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.can_access_tenant_file(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.can_manage_property_photo(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.can_manage_property(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_manage_tenant(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_access_tenant_file(text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_manage_property_photo(text) TO authenticated;

-- Replace the open policies.
DROP POLICY IF EXISTS "Anyone can view payment proofs" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated users can view payment proofs" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated users can upload payment proofs" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated users can update payment proofs" ON storage.objects;
DROP POLICY IF EXISTS "tenant_docs_select" ON storage.objects;
DROP POLICY IF EXISTS "tenant_docs_insert" ON storage.objects;
DROP POLICY IF EXISTS "tenant_docs_update" ON storage.objects;
DROP POLICY IF EXISTS "tenant_docs_delete" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated users can upload property photos" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated users can delete property photos" ON storage.objects;

DROP POLICY IF EXISTS "tenant_files_select" ON storage.objects;
DROP POLICY IF EXISTS "tenant_files_insert" ON storage.objects;
DROP POLICY IF EXISTS "tenant_files_update" ON storage.objects;
DROP POLICY IF EXISTS "tenant_files_delete" ON storage.objects;
DROP POLICY IF EXISTS "property_photos_insert" ON storage.objects;
DROP POLICY IF EXISTS "property_photos_update" ON storage.objects;
DROP POLICY IF EXISTS "property_photos_delete" ON storage.objects;

CREATE POLICY "tenant_files_select" ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id IN ('tenant-documents', 'payment-proofs') AND public.can_access_tenant_file(bucket_id, name));
CREATE POLICY "tenant_files_insert" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id IN ('tenant-documents', 'payment-proofs') AND public.can_access_tenant_file(bucket_id, name));
CREATE POLICY "tenant_files_update" ON storage.objects FOR UPDATE TO authenticated
  USING (bucket_id IN ('tenant-documents', 'payment-proofs') AND public.can_access_tenant_file(bucket_id, name))
  WITH CHECK (bucket_id IN ('tenant-documents', 'payment-proofs') AND public.can_access_tenant_file(bucket_id, name));
CREATE POLICY "tenant_files_delete" ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id IN ('tenant-documents', 'payment-proofs') AND public.can_access_tenant_file(bucket_id, name));

-- "Anyone can view property photos storage" (SELECT, public) is kept: listing photos are public.
CREATE POLICY "property_photos_insert" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'property-photos' AND public.can_manage_property_photo(name));
CREATE POLICY "property_photos_update" ON storage.objects FOR UPDATE TO authenticated
  USING (bucket_id = 'property-photos' AND public.can_manage_property_photo(name))
  WITH CHECK (bucket_id = 'property-photos' AND public.can_manage_property_photo(name));
CREATE POLICY "property_photos_delete" ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'property-photos' AND public.can_manage_property_photo(name));

-- Close the public links. Signed URLs keep working for the people above.
UPDATE storage.buckets SET public = false WHERE id IN ('tenant-documents', 'payment-proofs');
