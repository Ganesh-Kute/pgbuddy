-- Keep PG Buddy inside the Supabase free plan (500 MB database, 1 GB storage).
--
-- Measured 2026-11-22: uploads averaged 1 MB each (max 4.3 MB) with no size or type limit, so about a
-- thousand photos would fill the 1 GB. The app now compresses images before upload (about 150-250 KB);
-- these limits are the server-side backstop for old app versions and direct API calls.
-- Logs grew without end: cron run history since March, and every WhatsApp message ever queued.

-- 1. Upload limits per bucket (enforced by Supabase Storage on every upload).
UPDATE storage.buckets
SET file_size_limit = 2 * 1024 * 1024,
    allowed_mime_types = ARRAY['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
WHERE id IN ('tenant-documents', 'payment-proofs');

UPDATE storage.buckets
SET file_size_limit = 3 * 1024 * 1024,
    allowed_mime_types = ARRAY['image/jpeg', 'image/png', 'image/webp']
WHERE id = 'property-photos';

-- 2. Daily clean-up of rows nobody reads after a while.
CREATE OR REPLACE FUNCTION public.prune_old_logs()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _cron int := 0;
  _queue int := 0;
BEGIN
  -- pg_cron's own run history: a week is enough to see whether the reminders ran.
  DELETE FROM cron.job_run_details WHERE end_time < now() - interval '7 days';
  GET DIAGNOSTICS _cron = ROW_COUNT;

  -- WhatsApp messages already sent or given up on. Pending ones are never touched.
  DELETE FROM public.whatsapp_message_queue
  WHERE status IN ('sent', 'failed') AND created_at < now() - interval '30 days';
  GET DIAGNOSTICS _queue = ROW_COUNT;

  RETURN jsonb_build_object('cron_runs', _cron, 'whatsapp_queue', _queue);
END;
$$;

REVOKE ALL ON FUNCTION public.prune_old_logs() FROM PUBLIC, anon, authenticated;

DO $$
BEGIN
  PERFORM cron.unschedule('prune-old-logs');
EXCEPTION
  WHEN OTHERS THEN NULL;
END $$;

-- 04:10 UTC = 09:40 India time, after the 03:30 UTC rent reminders.
SELECT cron.schedule('prune-old-logs', '10 4 * * *', $$SELECT public.prune_old_logs()$$);
