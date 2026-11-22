-- Re-authenticate internal Supabase edge function callers via Vault secrets
-- Note: old migrations are kept immutable; this supersedes the anon-key cron and placeholder push trigger.
-- Before deploying edge functions with strict auth, add secrets in Supabase Vault (SQL Editor):
--   SELECT vault.create_secret('<YOUR_SERVICE_ROLE_KEY>', 'service_role_key');
--   -- Optionally also store a dedicated cron secret:
--   SELECT vault.create_secret('<YOUR_CRON_SECRET>', 'cron_secret');

DO $$
BEGIN
  PERFORM cron.unschedule('daily-rent-reminders');
EXCEPTION
  WHEN OTHERS THEN NULL;
END $$;

SELECT cron.schedule(
  'daily-rent-reminders',
  '30 3 * * *',
  $$
  DO $job$
  DECLARE
    v_service_key TEXT;
    v_cron_secret TEXT;
    v_headers JSONB;
  BEGIN
    SELECT decrypted_secret INTO v_service_key
    FROM vault.decrypted_secrets
    WHERE name = 'service_role_key'
    LIMIT 1;

    SELECT decrypted_secret INTO v_cron_secret
    FROM vault.decrypted_secrets
    WHERE name = 'cron_secret'
    LIMIT 1;

    IF v_service_key IS NOT NULL THEN
      v_headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || v_service_key
      );
      IF v_cron_secret IS NOT NULL THEN
        v_headers := v_headers || jsonb_build_object('x-cron-secret', v_cron_secret);
      END IF;
    ELSIF v_cron_secret IS NOT NULL THEN
      v_headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-cron-secret', v_cron_secret
      );
    ELSE
      RAISE WARNING 'daily-rent-reminders skipped: set service_role_key or cron_secret in vault.decrypted_secrets';
      RETURN;
    END IF;

    PERFORM net.http_post(
      url := 'https://vcpohetbsyyjqqkzuzxj.supabase.co/functions/v1/rent-reminders',
      headers := v_headers,
      body := '{}'::jsonb
    );
  END $job$;
  $$
);

CREATE OR REPLACE FUNCTION public.on_new_notification_send_push()
RETURNS TRIGGER AS $$
DECLARE
  v_service_key TEXT;
  v_cron_secret TEXT;
  v_anon_key TEXT;
  v_headers JSONB;
BEGIN
  IF NEW.user_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT decrypted_secret INTO v_service_key
  FROM vault.decrypted_secrets
  WHERE name = 'service_role_key'
  LIMIT 1;

  IF v_service_key IS NOT NULL THEN
    v_headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_service_key
    );
  ELSE
    SELECT decrypted_secret INTO v_cron_secret
    FROM vault.decrypted_secrets
    WHERE name = 'cron_secret'
    LIMIT 1;

    SELECT decrypted_secret INTO v_anon_key
    FROM vault.decrypted_secrets
    WHERE name = 'supabase_anon_key'
    LIMIT 1;

    IF v_cron_secret IS NOT NULL AND v_anon_key IS NOT NULL THEN
      v_headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || v_anon_key,
        'x-cron-secret', v_cron_secret
      );
    ELSE
      RAISE WARNING 'on_new_notification_send_push skipped: configure service_role_key in vault.decrypted_secrets';
      RETURN NEW;
    END IF;
  END IF;

  PERFORM net.http_post(
    url := 'https://vcpohetbsyyjqqkzuzxj.supabase.co/functions/v1/push-notifications',
    headers := v_headers,
    body := jsonb_build_object(
      'action', 'send',
      'target_user_ids', ARRAY[NEW.user_id],
      'title', NEW.title,
      'message', NEW.message,
      'url', COALESCE((NEW.metadata->>'url'), '/')
    )
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions;
