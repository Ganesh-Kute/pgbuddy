import {
  ConfigError,
  type EnvGetter,
  defaultGetEnv,
  extractBearerToken,
  handleCorsAndOrigin,
  jsonResponse,
  requireEnv,
  verifyRazorpayCheckoutSignature,
} from "../_shared/security.ts";

export interface VerifySubSupabaseClient {
  auth: {
    getUser(): Promise<{ data: { user: { id: string } | null }; error: { message: string } | null }>;
  };
  from(table: string): {
    select(columns: string): {
      eq(col: string, val: string): {
        single(): Promise<{ data: { id: string } | null; error: { message: string } | null }>;
      };
    };
    upsert(
      values: Record<string, unknown>,
      options: { onConflict: string },
    ): Promise<{ error: { message: string } | null }>;
  };
}

export type CreateVerifySubClientFn = (
  url: string,
  key: string,
  options?: { global: { headers: { Authorization: string } } },
) => VerifySubSupabaseClient;

export interface VerifySubscriptionDeps {
  createClient: CreateVerifySubClientFn;
  fetchFn?: typeof fetch;
  getEnv?: EnvGetter;
}

export function createVerifySubscriptionHandler({
  createClient,
  fetchFn = fetch,
  getEnv = defaultGetEnv,
}: VerifySubscriptionDeps) {
  return async (req: Request): Promise<Response> => {
    const { corsHeaders, response: corsResp } = handleCorsAndOrigin(req, [], getEnv);
    if (corsResp) return corsResp;

    if (req.method !== "POST") {
      return jsonResponse({ error: "Method not allowed" }, 405, corsHeaders);
    }

    try {
      const supabaseUrl = requireEnv("SUPABASE_URL", getEnv);
      const anonKey = requireEnv("SUPABASE_ANON_KEY", getEnv);
      const serviceRoleKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY", getEnv);
      const razorpayKeyId = requireEnv("RAZORPAY_KEY_ID", getEnv);
      const razorpayKeySecret = requireEnv("RAZORPAY_KEY_SECRET", getEnv);

      const token = extractBearerToken(req);
      if (!token) {
        return jsonResponse({ error: "Unauthorized" }, 401, corsHeaders);
      }

      const authHeader = `Bearer ${token}`;
      const userClient = createClient(supabaseUrl, anonKey, {
        global: { headers: { Authorization: authHeader } },
      });

      const { data: { user }, error: userError } = await userClient.auth.getUser();
      if (userError || !user) {
        return jsonResponse({ error: "Unauthorized" }, 401, corsHeaders);
      }
      const userId = user.id;

      let body: {
        razorpay_payment_id?: unknown;
        razorpay_subscription_id?: unknown;
        razorpay_signature?: unknown;
      };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return jsonResponse({ error: "Invalid JSON payload" }, 400, corsHeaders);
      }

      const paymentId = typeof body.razorpay_payment_id === "string" ? body.razorpay_payment_id.trim() : "";
      const subscriptionId = typeof body.razorpay_subscription_id === "string" ? body.razorpay_subscription_id.trim() : "";
      const signature = typeof body.razorpay_signature === "string" ? body.razorpay_signature.trim() : "";

      if (!paymentId || !subscriptionId || !signature) {
        return jsonResponse({ error: "Missing payment verification details or signature" }, 400, corsHeaders);
      }

      const sigValid = await verifyRazorpayCheckoutSignature(
        paymentId,
        subscriptionId,
        signature,
        razorpayKeySecret,
      );
      if (!sigValid) {
        return jsonResponse({ error: "Invalid payment signature" }, 401, corsHeaders);
      }

      const razorpayAuth = btoa(`${razorpayKeyId}:${razorpayKeySecret}`);
      const subRes = await fetchFn(`https://api.razorpay.com/v1/subscriptions/${encodeURIComponent(subscriptionId)}`, {
        headers: { Authorization: `Basic ${razorpayAuth}` },
      });

      const razorpaySub = (await subRes.json()) as {
        status?: string;
        notes?: { user_id?: string; plan_slug?: string; billing_cycle?: string };
      };
      if (!subRes.ok) {
        return jsonResponse({ error: "Failed to verify subscription with Razorpay" }, 502, corsHeaders);
      }

      if (razorpaySub.notes?.user_id !== userId) {
        return jsonResponse({ error: "Subscription does not belong to authenticated user" }, 403, corsHeaders);
      }

      if (razorpaySub.status !== "active" && razorpaySub.status !== "authenticated") {
        return jsonResponse(
          { error: "Subscription not active on Razorpay", razorpay_status: razorpaySub.status },
          400,
          corsHeaders,
        );
      }

      const serviceClient = createClient(supabaseUrl, serviceRoleKey);

      const billingCycle = razorpaySub.notes?.billing_cycle === "yearly" ? "yearly" : "monthly";
      const planSlug = razorpaySub.notes?.plan_slug;

      if (!planSlug) {
        return jsonResponse({ error: "Plan metadata missing from subscription" }, 400, corsHeaders);
      }

      const { data: plan, error: planError } = await serviceClient
        .from("subscription_plans")
        .select("id")
        .eq("slug", planSlug)
        .single();

      if (planError || !plan) {
        return jsonResponse({ error: "Subscription plan not found" }, 404, corsHeaders);
      }

      const now = new Date();
      const periodEnd = new Date(now);
      if (billingCycle === "yearly") {
        periodEnd.setFullYear(periodEnd.getFullYear() + 1);
      } else {
        periodEnd.setMonth(periodEnd.getMonth() + 1);
      }

      const { error: updateError } = await serviceClient.from("subscriptions").upsert(
        {
          user_id: userId,
          plan_id: plan.id,
          status: "active",
          billing_cycle: billingCycle,
          razorpay_subscription_id: subscriptionId,
          razorpay_payment_id: paymentId,
          current_period_start: now.toISOString(),
          current_period_end: periodEnd.toISOString(),
          updated_at: now.toISOString(),
        },
        { onConflict: "user_id" },
      );

      if (updateError) {
        console.error("Failed to upsert verified subscription:", updateError.message);
        return jsonResponse({ error: "Failed to activate subscription" }, 500, corsHeaders);
      }

      return jsonResponse({ success: true }, 200, corsHeaders);
    } catch (error) {
      if (error instanceof ConfigError) {
        return jsonResponse({ error: error.message }, error.status, corsHeaders);
      }
      console.error("Error verifying subscription:", error);
      return jsonResponse({ error: "Subscription verification failed" }, 500, corsHeaders);
    }
  };
}
