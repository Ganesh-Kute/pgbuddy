import {
  ConfigError,
  type EnvGetter,
  defaultGetEnv,
  extractBearerToken,
  handleCorsAndOrigin,
  jsonResponse,
  requireEnv,
  verifyCronOrServiceAuth,
} from "../_shared/security.ts";

export interface PushSubscriptionRow {
  id: string;
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface PushSupabaseClient {
  auth: {
    getUser(): Promise<{ data: { user: { id: string } | null }; error: { message: string } | null }>;
  };
  from(table: string): {
    select(columns: string): {
      in(col: string, vals: string[]): Promise<{ data: PushSubscriptionRow[] | null; error: { message: string } | null }>;
    };
    upsert(
      values: Record<string, unknown>,
      options: { onConflict: string },
    ): Promise<{ error: { message: string } | null }>;
    delete(): {
      eq(col: string, val: string): Promise<{ error: { message: string } | null }>;
    };
  };
}

export type CreatePushClientFn = (
  url: string,
  key: string,
  options?: { global: { headers: { Authorization: string } } },
) => PushSupabaseClient;

export type SendWebPushFn = (
  subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
  payload: string,
  vapid: { subject: string; publicKey: string; privateKey: string },
) => Promise<void>;

export interface PushNotificationsDeps {
  createClient: CreatePushClientFn;
  sendWebPush: SendWebPushFn;
  getEnv?: EnvGetter;
}

interface PushRequestBody {
  action?: unknown;
  subscription?: {
    endpoint?: unknown;
    keys?: { p256dh?: unknown; auth?: unknown };
  };
  user_id?: unknown;
  title?: unknown;
  message?: unknown;
  target_user_ids?: unknown;
  url?: unknown;
}

function isValidHttpsEndpoint(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export function createPushNotificationsHandler({
  createClient,
  sendWebPush,
  getEnv = defaultGetEnv,
}: PushNotificationsDeps) {
  return async (req: Request): Promise<Response> => {
    const { corsHeaders, response: corsResp } = handleCorsAndOrigin(req, ["x-cron-secret"], getEnv);
    if (corsResp) return corsResp;

    if (req.method !== "POST") {
      return jsonResponse({ error: "Method not allowed" }, 405, corsHeaders);
    }

    try {
      const supabaseUrl = requireEnv("SUPABASE_URL", getEnv);
      const anonKey = requireEnv("SUPABASE_ANON_KEY", getEnv);
      const serviceRoleKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY", getEnv);
      const vapidPublicKey = requireEnv("VAPID_PUBLIC_KEY", getEnv);
      const vapidPrivateKey = requireEnv("VAPID_PRIVATE_KEY", getEnv);

      const serviceAuth = verifyCronOrServiceAuth(req, getEnv);
      let isServiceOrCron = false;
      let authUserId: string | null = null;

      if (serviceAuth.authorized) {
        isServiceOrCron = true;
      } else {
        const token = extractBearerToken(req);
        if (token) {
          const userClient = createClient(supabaseUrl, anonKey, {
            global: { headers: { Authorization: `Bearer ${token}` } },
          });
          const { data: { user }, error: userError } = await userClient.auth.getUser();
          if (!userError && user) {
            authUserId = user.id;
          }
        }
      }

      if (!isServiceOrCron && !authUserId) {
        if (!serviceAuth.authorized && req.headers.get("x-cron-secret") && serviceAuth.status === 500) {
          return jsonResponse({ error: serviceAuth.error || "Server configuration error" }, 500, corsHeaders);
        }
        return jsonResponse({ error: "Unauthorized" }, 401, corsHeaders);
      }

      let body: PushRequestBody;
      try {
        body = (await req.json()) as PushRequestBody;
      } catch {
        return jsonResponse({ error: "Invalid JSON payload" }, 400, corsHeaders);
      }

      const action = typeof body.action === "string" ? body.action.trim() : "";
      const supabase = createClient(supabaseUrl, serviceRoleKey);

      if (action === "get-vapid-key") {
        return jsonResponse({ vapidPublicKey }, 200, corsHeaders);
      }

      if (action === "subscribe") {
        const requestedUserId = typeof body.user_id === "string" ? body.user_id.trim() : "";
        if (authUserId && requestedUserId && requestedUserId !== authUserId) {
          return jsonResponse({ error: "Forbidden: cannot manage another user's subscription" }, 403, corsHeaders);
        }
        const targetUserId = authUserId ?? requestedUserId;
        const endpoint = body.subscription?.endpoint;
        const p256dh = body.subscription?.keys?.p256dh;
        const auth = body.subscription?.keys?.auth;

        if (
          !targetUserId ||
          !isValidHttpsEndpoint(endpoint) ||
          typeof p256dh !== "string" ||
          !p256dh.trim() ||
          typeof auth !== "string" ||
          !auth.trim()
        ) {
          return jsonResponse({ error: "Missing or invalid push subscription details" }, 400, corsHeaders);
        }

        const { error } = await supabase.from("push_subscriptions").upsert(
          {
            user_id: targetUserId,
            endpoint: endpoint.trim(),
            p256dh: p256dh.trim(),
            auth: auth.trim(),
          },
          { onConflict: "user_id,endpoint" },
        );

        if (error) {
          console.error("Error saving subscription:", error.message);
          return jsonResponse({ error: "Failed to save subscription" }, 500, corsHeaders);
        }

        return jsonResponse({ success: true }, 200, corsHeaders);
      }

      if (action === "unsubscribe") {
        const requestedUserId = typeof body.user_id === "string" ? body.user_id.trim() : "";
        if (authUserId && requestedUserId && requestedUserId !== authUserId) {
          return jsonResponse({ error: "Forbidden: cannot remove another user's subscription" }, 403, corsHeaders);
        }
        const targetUserId = authUserId ?? requestedUserId;
        if (!targetUserId) {
          return jsonResponse({ error: "Missing user_id" }, 400, corsHeaders);
        }

        const { error } = await supabase.from("push_subscriptions").delete().eq("user_id", targetUserId);
        if (error) {
          console.error("Error removing subscription:", error.message);
          return jsonResponse({ error: "Failed to remove subscription" }, 500, corsHeaders);
        }

        return jsonResponse({ success: true }, 200, corsHeaders);
      }

      if (action === "send") {
        if (!isServiceOrCron) {
          return jsonResponse({ error: "Forbidden: server credentials required for push delivery" }, 403, corsHeaders);
        }

        const targetUserIds = Array.isArray(body.target_user_ids)
          ? body.target_user_ids.filter((id): id is string => typeof id === "string" && id.trim().length > 0)
          : [];
        const title = typeof body.title === "string" ? body.title.trim() : "";
        const message = typeof body.message === "string" ? body.message.trim() : "";
        const targetUrl = typeof body.url === "string" && body.url.trim() ? body.url.trim() : "/";

        if (targetUserIds.length === 0 || !title || !message) {
          return jsonResponse({ error: "Missing target_user_ids, title, or message" }, 400, corsHeaders);
        }

        const { data: subscriptions, error: subErr } = await supabase
          .from("push_subscriptions")
          .select("*")
          .in("user_id", targetUserIds);

        if (subErr) {
          console.error("Error fetching subscriptions:", subErr.message);
          return jsonResponse({ error: "Failed to query subscriptions" }, 500, corsHeaders);
        }

        if (!subscriptions || subscriptions.length === 0) {
          return jsonResponse(
            { sent: 0, message: "No push subscriptions found for target users" },
            200,
            corsHeaders,
          );
        }

        const payload = JSON.stringify({
          title,
          body: message,
          icon: "/pwa-icon-192.png",
          badge: "/pwa-icon-192.png",
          url: targetUrl,
          timestamp: Date.now(),
        });

        let sent = 0;
        let failed = 0;

        for (const sub of subscriptions) {
          try {
            await sendWebPush(
              {
                endpoint: sub.endpoint,
                keys: { p256dh: sub.p256dh, auth: sub.auth },
              },
              payload,
              {
                subject: "mailto:support@pgbuddy.lovable.app",
                publicKey: vapidPublicKey,
                privateKey: vapidPrivateKey,
              },
            );
            sent++;
          } catch (err: unknown) {
            const statusCode = (err as { statusCode?: number })?.statusCode;
            const errMsg = err instanceof Error ? err.message : String(err);
            console.error(`Push failed for subscription ${sub.id}: ${errMsg}`);
            if (statusCode === 410 || statusCode === 404) {
              await supabase.from("push_subscriptions").delete().eq("id", sub.id);
            }
            failed++;
          }
        }

        return jsonResponse({ sent, failed, total: subscriptions.length }, 200, corsHeaders);
      }

      return jsonResponse({ error: "Unknown action" }, 400, corsHeaders);
    } catch (err) {
      if (err instanceof ConfigError) {
        return jsonResponse({ error: err.message }, err.status, corsHeaders);
      }
      console.error("Unexpected push-notifications error:", err);
      return jsonResponse({ error: "Internal server error" }, 500, corsHeaders);
    }
  };
}
