import {
  ConfigError,
  type EnvGetter,
  defaultGetEnv,
  handleCorsAndOrigin,
  isUuid,
  jsonResponse,
  requireEnv,
} from "../_shared/security.ts";

export interface GetReceiptSupabaseClient {
  from(table: string): {
    select(columns: string): {
      eq(col: string, val: string): {
        eq(col2: string, val2: string): {
          maybeSingle(): Promise<{ data: Record<string, unknown> | null; error: { message: string } | null }>;
        };
        maybeSingle(): Promise<{ data: Record<string, unknown> | null; error: { message: string } | null }>;
      };
    };
  };
}

export type CreateClientFn = (url: string, key: string) => GetReceiptSupabaseClient;

export interface GetReceiptDeps {
  createClient: CreateClientFn;
  getEnv?: EnvGetter;
}

export function createGetReceiptHandler({ createClient, getEnv = defaultGetEnv }: GetReceiptDeps) {
  return async (req: Request): Promise<Response> => {
    const { corsHeaders, response: corsResp } = handleCorsAndOrigin(req, [], getEnv);
    if (corsResp) return corsResp;

    if (req.method !== "GET") {
      return jsonResponse({ error: "Method not allowed" }, 405, corsHeaders);
    }

    try {
      const supabaseUrl = requireEnv("SUPABASE_URL", getEnv);
      const supabaseKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY", getEnv);

      const url = new URL(req.url);
      const receiptId = url.searchParams.get("id")?.trim() || "";

      if (!receiptId || !isUuid(receiptId)) {
        return jsonResponse({ error: "Valid receipt ID is required" }, 400, corsHeaders);
      }

      const supabase = createClient(supabaseUrl, supabaseKey);

      const { data, error } = await supabase
        .from("rent_payments")
        .select("id, amount, month, payment_date, status, payment_type, payment_method, transaction_id, tenant_name, tenant_id, property_id, room_id")
        .eq("id", receiptId)
        .eq("status", "paid")
        .maybeSingle();

      if (error) {
        console.error("DB Error fetching receipt:", error.message);
        return jsonResponse({ error: "Receipt not found" }, 404, corsHeaders);
      }

      if (!data) {
        return jsonResponse({ error: "Receipt not found" }, 404, corsHeaders);
      }

      let propertyName: string | null = null;
      let propertyAddress: string | null = null;
      let ownerId: string | null = null;
      let ownerName: string | null = null;
      let roomNumber: string | null = null;
      let tenantFullName: string | null = (typeof data.tenant_name === "string" && data.tenant_name) ? data.tenant_name : null;

      if (typeof data.property_id === "string" && data.property_id) {
        const { data: prop } = await supabase
          .from("properties")
          .select("name, address, owner_id")
          .eq("id", data.property_id)
          .maybeSingle();
        propertyName = (prop?.name as string) || null;
        propertyAddress = (prop?.address as string) || null;
        ownerId = (prop?.owner_id as string) || null;
      }

      if (ownerId) {
        const { data: ownerProfile } = await supabase
          .from("profiles")
          .select("full_name")
          .eq("user_id", ownerId)
          .maybeSingle();
        ownerName = (ownerProfile?.full_name as string) || null;
      }

      if (typeof data.room_id === "string" && data.room_id) {
        const { data: room } = await supabase
          .from("rooms")
          .select("room_number")
          .eq("id", data.room_id)
          .maybeSingle();
        roomNumber = (room?.room_number as string) || null;
      }

      if (typeof data.tenant_id === "string" && data.tenant_id && !tenantFullName) {
        const { data: profile } = await supabase
          .from("profiles")
          .select("full_name")
          .eq("user_id", data.tenant_id)
          .maybeSingle();
        tenantFullName = (profile?.full_name as string) || null;
      }

      const receipt = {
        id: data.id,
        amount: data.amount,
        month: data.month,
        payment_date: data.payment_date,
        status: data.status,
        payment_type: data.payment_type,
        payment_method: data.payment_method,
        transaction_id: data.transaction_id,
        properties: propertyName
          ? { name: propertyName, address: propertyAddress, owner_name: ownerName }
          : null,
        rooms: roomNumber ? { room_number: roomNumber } : null,
        profiles: tenantFullName ? { full_name: tenantFullName } : null,
      };

      return jsonResponse({ receipt }, 200, corsHeaders);
    } catch (err) {
      if (err instanceof ConfigError) {
        return jsonResponse({ error: err.message }, err.status, corsHeaders);
      }
      console.error("Unexpected get-receipt error:", err);
      return jsonResponse({ error: "Internal server error" }, 500, corsHeaders);
    }
  };
}
