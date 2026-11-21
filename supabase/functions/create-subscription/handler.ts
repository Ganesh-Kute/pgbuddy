import {
  ConfigError,
  type EnvGetter,
  defaultGetEnv,
  extractBearerToken,
  handleCorsAndOrigin,
  jsonResponse,
  requireEnv,
} from "../_shared/security.ts";

export interface SubscriptionPlanRow {
  id: string;
  slug: string;
  name: string;
  description?: string | null;
  monthly_price: number;
  yearly_price: number;
}

export interface CreateSubSupabaseClient {
  auth: {
    getUser(): Promise<{ data: { user: { id: string } | null }; error: { message: string } | null }>;
  };
  from(table: string): {
    select(columns: string): {
      eq(col: string, val: string): {
        single(): Promise<{ data: SubscriptionPlanRow | null; error: { message: string } | null }>;
      };
    };
    upsert(
      values: Record<string, unknown>,
      options: { onConflict: string },
    ): Promise<{ error: { message: string } | null }>;
  };
}

export type CreateSubClientFn = (
  url: string,
  key: string,
  options?: { global: { headers: { Authorization: string } } },
) => CreateSubSupabaseClient;

export interface CreateSubscriptionDeps {
  createClient: CreateSubClientFn;
  fetchFn?: typeof fetch;
  getEnv?: EnvGetter;
}

export function createCreateSubscriptionHandler({
  createClient,
  fetchFn = fetch,
  getEnv = defaultGetEnv,
}: CreateSubscriptionDeps) {
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

      const token = extractBearerToken(req);
      if (!token) {
        return jsonResponse({ error: "No auth token provided" }, 401, corsHeaders);
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

      let parsedBody: { plan_slug?: unknown; billing_cycle?: unknown };
      try {
        parsedBody = (await req.json()) as { plan_slug?: unknown; billing_cycle?: unknown };
      } catch {
        return jsonResponse({ error: "Invalid JSON payload" }, 400, corsHeaders);
      }

      const planSlug = typeof parsedBody.plan_slug === "string" ? parsedBody.plan_slug.trim() : "";
      const billingCycle = parsedBody.billing_cycle === "yearly" ? "yearly" : parsedBody.billing_cycle === "monthly" ? "monthly" : null;

      if (!planSlug || !billingCycle) {
        return jsonResponse({ error: "plan_slug and billing_cycle (monthly|yearly) are required" }, 400, corsHeaders);
      }

      const serviceClient = createClient(supabaseUrl, serviceRoleKey);

      const { data: plan, error: planError } = await serviceClient
        .from("subscription_plans")
        .select("*")
        .eq("slug", planSlug)
        .single();

      if (planError || !plan) {
        return jsonResponse({ error: `Plan '${planSlug}' not found` }, 404, corsHeaders);
      }

      if (plan.slug === "free") {
        const { error: subError } = await serviceClient.from("subscriptions").upsert(
          {
            user_id: userId,
            plan_id: plan.id,
            status: "active",
            billing_cycle: "monthly",
            current_period_start: new Date().toISOString(),
            current_period_end: null,
          },
          { onConflict: "user_id" },
        );

        if (subError) {
          console.error("Free sub upsert error:", subError.message);
          return jsonResponse({ error: "Free plan activation failed" }, 500, corsHeaders);
        }

        return jsonResponse({ success: true, free: true }, 200, corsHeaders);
      }

      const razorpayKeyId = requireEnv("RAZORPAY_KEY_ID", getEnv);
      const razorpayKeySecret = requireEnv("RAZORPAY_KEY_SECRET", getEnv);

      const amount = billingCycle === "yearly" ? Number(plan.yearly_price) : Number(plan.monthly_price);
      if (!Number.isFinite(amount) || amount <= 0) {
        return jsonResponse({ error: "Invalid plan pricing configuration" }, 400, corsHeaders);
      }

      const razorpayAuth = btoa(`${razorpayKeyId}:${razorpayKeySecret}`);

      const planRes = await fetchFn("https://api.razorpay.com/v1/plans", {
        method: "POST",
        headers: {
          Authorization: `Basic ${razorpayAuth}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          period: billingCycle,
          interval: 1,
          item: {
            name: `${plan.name} Plan (${billingCycle})`,
            amount: Math.round(amount * 100),
            currency: "INR",
            description: plan.description || "",
          },
        }),
      });

      const razorpayPlan = (await planRes.json()) as { id?: string; error?: { description?: string } };
      if (!planRes.ok || !razorpayPlan.id) {
        return jsonResponse(
          { error: razorpayPlan.error?.description || "Failed to initialize payment plan" },
          502,
          corsHeaders,
        );
      }

      const subRes = await fetchFn("https://api.razorpay.com/v1/subscriptions", {
        method: "POST",
        headers: {
          Authorization: `Basic ${razorpayAuth}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          plan_id: razorpayPlan.id,
          total_count: billingCycle === "yearly" ? 10 : 120,
          quantity: 1,
          notes: {
            user_id: userId,
            plan_slug: planSlug,
            billing_cycle: billingCycle,
          },
        }),
      });

      const razorpaySub = (await subRes.json()) as { id?: string; error?: { description?: string } };
      if (!subRes.ok || !razorpaySub.id) {
        return jsonResponse(
          { error: razorpaySub.error?.description || "Failed to create subscription" },
          502,
          corsHeaders,
        );
      }

      return jsonResponse(
        {
          subscription_id: razorpaySub.id,
          razorpay_key: razorpayKeyId,
          amount: Math.round(amount * 100),
          plan_name: plan.name,
          billing_cycle: billingCycle,
        },
        200,
        corsHeaders,
      );
    } catch (error) {
      if (error instanceof ConfigError) {
        return jsonResponse({ error: error.message }, error.status, corsHeaders);
      }
      console.error("Unhandled create-subscription error:", error);
      return jsonResponse({ error: "Failed to create subscription" }, 500, corsHeaders);
    }
  };
}
