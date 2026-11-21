import {
  ConfigError,
  type EnvGetter,
  defaultGetEnv,
  handleCorsAndOrigin,
  jsonResponse,
  requireEnv,
  verifyRazorpayWebhookSignature,
} from "../_shared/security.ts";

export interface WebhookSupabaseClient {
  from(table: string): {
    update(values: Record<string, unknown>): {
      eq(col: string, val: string): Promise<{ error: { message: string } | null }>;
    };
  };
}

export type CreateWebhookClientFn = (url: string, key: string) => WebhookSupabaseClient;

export interface RazorpayWebhookDeps {
  createClient: CreateWebhookClientFn;
  getEnv?: EnvGetter;
}

interface RazorpayWebhookPayload {
  event?: string;
  payload?: {
    subscription?: {
      entity?: {
        id?: string;
        notes?: { billing_cycle?: string };
      };
    };
    payment?: {
      entity?: {
        id?: string;
      };
    };
  };
}

export function createRazorpayWebhookHandler({ createClient, getEnv = defaultGetEnv }: RazorpayWebhookDeps) {
  return async (req: Request): Promise<Response> => {
    const { corsHeaders, response: corsResp } = handleCorsAndOrigin(
      req,
      ["x-razorpay-signature"],
      getEnv,
    );
    if (corsResp) return corsResp;

    if (req.method !== "POST") {
      return jsonResponse({ error: "Method not allowed" }, 405, corsHeaders);
    }

    try {
      const supabaseUrl = requireEnv("SUPABASE_URL", getEnv);
      const serviceRoleKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY", getEnv);
      const webhookSecret =
        getEnv("RAZORPAY_WEBHOOK_SECRET")?.trim() || requireEnv("RAZORPAY_KEY_SECRET", getEnv);

      const signature = req.headers.get("x-razorpay-signature");
      if (!signature) {
        return jsonResponse({ error: "Missing signature" }, 401, corsHeaders);
      }

      const body = await req.text();
      const valid = await verifyRazorpayWebhookSignature(body, signature, webhookSecret);
      if (!valid) {
        return jsonResponse({ error: "Invalid signature" }, 401, corsHeaders);
      }

      let event: RazorpayWebhookPayload;
      try {
        event = JSON.parse(body) as RazorpayWebhookPayload;
      } catch {
        return jsonResponse({ error: "Invalid JSON payload" }, 400, corsHeaders);
      }

      const supabase = createClient(supabaseUrl, serviceRoleKey);
      const eventType = event.event;
      const payload = event.payload;

      if (eventType === "subscription.activated" || eventType === "subscription.charged") {
        const subscriptionId = payload?.subscription?.entity?.id;
        const paymentId = payload?.payment?.entity?.id ?? null;
        const notes = payload?.subscription?.entity?.notes || {};

        if (subscriptionId) {
          const now = new Date();
          const billingCycle = notes.billing_cycle === "yearly" ? "yearly" : "monthly";
          const periodEnd = new Date(now);
          if (billingCycle === "yearly") {
            periodEnd.setFullYear(periodEnd.getFullYear() + 1);
          } else {
            periodEnd.setMonth(periodEnd.getMonth() + 1);
          }

          const { error: dbErr } = await supabase
            .from("subscriptions")
            .update({
              status: "active",
              razorpay_payment_id: paymentId,
              current_period_start: now.toISOString(),
              current_period_end: periodEnd.toISOString(),
              updated_at: now.toISOString(),
            })
            .eq("razorpay_subscription_id", subscriptionId);

          if (dbErr) {
            console.error("Failed to update subscription on charge:", dbErr.message);
            return jsonResponse({ error: "Failed to persist subscription state" }, 500, corsHeaders);
          }
        }
      } else if (eventType === "subscription.cancelled" || eventType === "subscription.completed") {
        const subscriptionId = payload?.subscription?.entity?.id;
        if (subscriptionId) {
          const nowIso = new Date().toISOString();
          const { error: dbErr } = await supabase
            .from("subscriptions")
            .update({
              status: "cancelled",
              cancelled_at: nowIso,
              updated_at: nowIso,
            })
            .eq("razorpay_subscription_id", subscriptionId);

          if (dbErr) {
            console.error("Failed to update subscription on cancel:", dbErr.message);
            return jsonResponse({ error: "Failed to persist subscription state" }, 500, corsHeaders);
          }
        }
      } else if (eventType === "subscription.halted" || eventType === "subscription.pending") {
        const subscriptionId = payload?.subscription?.entity?.id;
        if (subscriptionId) {
          const { error: dbErr } = await supabase
            .from("subscriptions")
            .update({
              status: "past_due",
              updated_at: new Date().toISOString(),
            })
            .eq("razorpay_subscription_id", subscriptionId);

          if (dbErr) {
            console.error("Failed to update subscription on halt:", dbErr.message);
            return jsonResponse({ error: "Failed to persist subscription state" }, 500, corsHeaders);
          }
        }
      }

      return jsonResponse({ success: true }, 200, corsHeaders);
    } catch (error) {
      if (error instanceof ConfigError) {
        return jsonResponse({ error: error.message }, error.status, corsHeaders);
      }
      console.error("Webhook error:", error);
      return jsonResponse({ error: "Webhook processing failed" }, 500, corsHeaders);
    }
  };
}
