import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { createPushNotificationsHandler, type SendWebPushFn } from "./handler.ts";

const sendWebPush: SendWebPushFn = async (subscription, payload, vapid) => {
  const { default: webpush } = await import("npm:web-push@3.6.7");
  webpush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);
  await webpush.sendNotification(subscription, payload);
};

Deno.serve(createPushNotificationsHandler({ createClient, sendWebPush }));
