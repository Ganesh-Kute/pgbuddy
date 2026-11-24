import {
  ConfigError,
  type EnvGetter,
  defaultGetEnv,
  handleCorsAndOrigin,
  jsonResponse,
  requireEnv,
  verifyCronOrServiceAuth,
} from "../_shared/security.ts";

interface AssignmentRow {
  property_id: string | null;
  room_id: string | null;
  tenant_email: string | null;
  tenant_phone: string | null;
  move_in_date: string;
}

interface PendingPaymentRow {
  id: string;
  tenant_id: string | null;
  tenant_email: string | null;
  tenant_phone: string | null;
  amount: number;
  month: string;
  status: string;
  property_id: string;
  room_id: string;
  properties: { name?: string } | null;
  rooms: { room_number?: string } | null;
}

interface ExistingNotificationRow {
  user_id?: string | null;
  metadata?: {
    reminder_type?: string;
    payment_id?: string;
    mess_payment_id?: string;
  } | null;
}

interface PendingMessRow {
  id: string;
  member_id: string;
  month: string;
  final_amount: number | null;
  status: string;
  mess_members: {
    full_name?: string | null;
    phone?: string | null;
    start_date?: string | null;
    status?: string | null;
    mess_plans?: { name?: string | null } | null;
  } | null;
}

interface RentReminderPayload extends PendingPaymentRow {
  reminderType: string;
  /** yyyy-mm-dd, for the WhatsApp template. */
  dueDateIso: string;
  titleTemplate: string;
  messageTemplate: (pName: string, room: string, amt: number) => string;
}

interface MessReminderPayload extends PendingMessRow {
  reminderType: string;
  startDay: number;
  ord: string;
}

export interface RentQueryChain extends PromiseLike<{ data: unknown[] | null; error: { message: string } | null }> {
  eq(col: string, val: unknown): RentQueryChain;
  gte(col: string, val: string): PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>;
}

export interface RentRemindersSupabaseClient {
  from(table: string): {
    select(columns: string): {
      eq(col: string, val: unknown): RentQueryChain;
    };
    insert(rows: Record<string, unknown>[]): Promise<{ error: { message: string } | null }>;
  };
}

export type CreateRentClientFn = (url: string, key: string) => RentRemindersSupabaseClient;

export interface RentRemindersDeps {
  createClient: CreateRentClientFn;
  fetchFn?: typeof fetch;
  getEnv?: EnvGetter;
  nowFn?: () => Date;
}

export function createRentRemindersHandler({
  createClient,
  fetchFn = fetch,
  getEnv = defaultGetEnv,
  nowFn = () => new Date(),
}: RentRemindersDeps) {
  return async (req: Request): Promise<Response> => {
    const { corsHeaders, response: corsResp } = handleCorsAndOrigin(req, ["x-cron-secret"], getEnv);
    if (corsResp) return corsResp;

    if (req.method !== "POST") {
      return jsonResponse({ error: "Method not allowed" }, 405, corsHeaders);
    }

    try {
      const supabaseUrl = requireEnv("SUPABASE_URL", getEnv);
      const serviceRoleKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY", getEnv);

      const auth = verifyCronOrServiceAuth(req, getEnv);
      if (!auth.authorized) {
        return jsonResponse({ error: auth.error || "Unauthorized" }, auth.status || 401, corsHeaders);
      }

      const cronSecret = getEnv("CRON_SECRET")?.trim();
      const supabase = createClient(supabaseUrl, serviceRoleKey);

      const today = nowFn();
      const todayNum = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())).getTime();
      const currentMonth = `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, "0")}`;
      const [year, month] = currentMonth.split("-").map(Number);

      const { data: assignmentsData } = await supabase
        .from("tenant_assignments")
        .select("property_id, room_id, tenant_email, tenant_phone, move_in_date")
        .eq("is_active", true);

      const assignments = (assignmentsData as AssignmentRow[] | null) ?? [];
      const moveInDays: Record<string, number> = {};
      for (const a of assignments) {
        const day = new Date(a.move_in_date).getUTCDate();
        if (a.property_id && a.room_id) {
          moveInDays[`${a.property_id}_${a.room_id}`] = day;
        }
        if (a.tenant_email) moveInDays[`email_${a.tenant_email}`] = day;
        if (a.tenant_phone) moveInDays[`phone_${a.tenant_phone}`] = day;
      }

      const { data: paymentsData, error: payErr } = await supabase
        .from("rent_payments")
        .select(`
          id, tenant_id, tenant_email, tenant_phone, amount, month, status, property_id, room_id,
          properties:property_id(name), rooms:room_id(room_number)
        `)
        .eq("status", "pending")
        .eq("month", currentMonth);

      if (payErr) console.error("Error fetching payments:", payErr.message);
      const pendingPayments = (paymentsData as PendingPaymentRow[] | null) ?? [];

      const rentPayloads: RentReminderPayload[] = [];
      for (const p of pendingPayments) {
        let dueDay = 1;
        const rKey = `${p.property_id}_${p.room_id}`;
        if (moveInDays[rKey]) dueDay = moveInDays[rKey];
        else if (p.tenant_email && moveInDays[`email_${p.tenant_email}`]) dueDay = moveInDays[`email_${p.tenant_email}`];
        else if (p.tenant_phone && moveInDays[`phone_${p.tenant_phone}`]) dueDay = moveInDays[`phone_${p.tenant_phone}`];

        const ord = ["st", "nd", "rd"][(((dueDay + 90) % 100) - 10) % 10 - 1] || "th";
        const dueDate = new Date(Date.UTC(year, month - 1, dueDay));
        const daysDiff = Math.floor((todayNum - dueDate.getTime()) / (1000 * 60 * 60 * 24));

        let reminderType: string | null = null;
        let titleTemplate = "";
        let messageTemplate: (pName: string, room: string, amt: number) => string = () => "";

        if (daysDiff === -3) {
          reminderType = "upcoming";
          titleTemplate = "🔔 Rent Due in 3 Days";
          messageTemplate = (pName, room, amt) =>
            `Your rent of ₹${amt.toLocaleString()} for ${pName} (Room ${room}) is due on the ${dueDay}${ord}. Please pay on time to avoid late fees.`;
        } else if (daysDiff === 0) {
          reminderType = "due_today";
          titleTemplate = "⚠️ Rent Due Today";
          messageTemplate = (pName, room, amt) =>
            `Your rent of ₹${amt.toLocaleString()} for ${pName} (Room ${room}) is due today (${dueDay}${ord}). Please make the payment at your earliest convenience.`;
        } else if (daysDiff === 3) {
          reminderType = "overdue";
          titleTemplate = "🚨 Rent Overdue";
          messageTemplate = (pName, room, amt) =>
            `Your rent of ₹${amt.toLocaleString()} for ${pName} (Room ${room}) is 3 days overdue. Please pay immediately to avoid penalties.`;
        }

        if (reminderType) {
          rentPayloads.push({ ...p, reminderType, titleTemplate, messageTemplate, dueDateIso: dueDate.toISOString().slice(0, 10) });
        }
      }

      const dispatchHeaders: Record<string, string> = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${serviceRoleKey}`,
        "Bypass-Tunnel-Reminder": "true",
      };
      if (cronSecret) {
        dispatchHeaders["x-cron-secret"] = cronSecret;
      }

      let sent = 0;
      if (rentPayloads.length > 0) {
        const { data: existingData } = await supabase
          .from("notifications")
          .select("user_id, metadata")
          .eq("type", "reminder")
          .gte(`created_at`, `${currentMonth}-01T00:00:00Z`);

        const existingNotifs = (existingData as ExistingNotificationRow[] | null) ?? [];
        const alreadyNotified = new Set(
          existingNotifs.map((n) => `${n.metadata?.reminder_type}_${n.metadata?.payment_id}`),
        );

        const validRentPayloads = rentPayloads.filter(
          (p) => !alreadyNotified.has(`${p.reminderType}_${p.id}`),
        );

        const notifications = validRentPayloads.map((p) => ({
          user_id: p.tenant_id,
          title: p.titleTemplate,
          message: p.messageTemplate(
            p.properties?.name || "your PG",
            p.rooms?.room_number || "N/A",
            Number(p.amount),
          ),
          type: "reminder",
          metadata: {
            reminder_type: p.reminderType,
            payment_id: p.id,
            month: currentMonth,
            amount: p.amount,
            property_id: p.property_id,
            tenant_email: p.tenant_email,
          },
        }));

        if (notifications.length > 0) {
          const { error: insertErr } = await supabase.from("notifications").insert(notifications);
          if (insertErr) {
            console.error("Error inserting notifications:", insertErr.message);
          } else {
            sent = notifications.length;
            try {
              for (const p of validRentPayloads) {
                const phoneNumber = p.tenant_phone;
                if (phoneNumber || p.tenant_id) {
                  const resp = await fetchFn(`${supabaseUrl}/functions/v1/twilio-notifications`, {
                    method: "POST",
                    headers: dispatchHeaders,
                    body: JSON.stringify({
                      action: "send-rent-reminder",
                      tenant_ids: p.tenant_id ? [p.tenant_id] : [],
                      tenant_phone: phoneNumber,
                      property_name: p.properties?.name ?? "your PG",
                      room_number: p.rooms?.room_number ?? "N/A",
                      amount: p.amount,
                      month: currentMonth,
                      due_date: p.dueDateIso,
                      reminder_type: p.reminderType,
                    }),
                  });
                  if (!resp.ok) {
                    console.warn(`WhatsApp rent reminder returned HTTP ${resp.status}`);
                  }
                }
              }
            } catch (waErr: unknown) {
              console.error("WhatsApp dispatch error (non-fatal):", waErr instanceof Error ? waErr.message : String(waErr));
            }
          }
        }
      }

      let messSent = 0;
      try {
        const { data: messData, error: messErr } = await supabase
          .from("mess_payments")
          .select(`
            id, member_id, month, final_amount, status,
            mess_members!inner ( full_name, phone, start_date, status, mess_plans ( name ) )
          `)
          .eq("status", "pending")
          .eq("month", currentMonth)
          .eq(`mess_members.status`, "active");

        if (messErr) {
          console.error("Error fetching mess payments:", messErr.message);
        } else {
          const pendingMess = (messData as PendingMessRow[] | null) ?? [];
          const messPayloads: MessReminderPayload[] = [];
          for (const p of pendingMess) {
            const startDay = p.mess_members?.start_date ? new Date(p.mess_members.start_date).getUTCDate() : 1;
            const ord = ["st", "nd", "rd"][(((startDay + 90) % 100) - 10) % 10 - 1] || "th";
            const dueDate = new Date(Date.UTC(year, month - 1, startDay));
            const daysDiff = Math.floor((todayNum - dueDate.getTime()) / (1000 * 60 * 60 * 24));

            let reminderType: string | null = null;
            if (daysDiff === -3) reminderType = "upcoming";
            else if (daysDiff === 0) reminderType = "due_today";
            else if (daysDiff === 3) reminderType = "overdue";

            if (reminderType) {
              messPayloads.push({ ...p, reminderType, startDay, ord });
            }
          }

          if (messPayloads.length > 0) {
            const { data: existingMessData } = await supabase
              .from("notifications")
              .select("metadata")
              .eq("type", "reminder")
              .gte(`created_at`, `${currentMonth}-01T00:00:00Z`);

            const existingMessNotifs = (existingMessData as ExistingNotificationRow[] | null) ?? [];
            const alreadyNotifiedMess = new Set(
              existingMessNotifs.map((n) => `${n.metadata?.reminder_type}_${n.metadata?.mess_payment_id}`),
            );

            const validMessPayloads = messPayloads.filter(
              (p) => !alreadyNotifiedMess.has(`${p.reminderType}_${p.id}`),
            );

            const messNotifications = validMessPayloads.map((p) => ({
              user_id: null,
              title: `Mess Fee ${p.reminderType === "upcoming" ? "Due Soon" : p.reminderType === "overdue" ? "Overdue" : "Due Today"}`,
              message: `Your mess fee of ₹${p.final_amount?.toLocaleString() || 0} for ${p.mess_members?.mess_plans?.name || "Mess"} is due on the ${p.startDay}${p.ord}.`,
              type: "reminder",
              metadata: {
                reminder_type: p.reminderType,
                mess_payment_id: p.id,
                month: currentMonth,
                amount: p.final_amount,
              },
            }));

            if (messNotifications.length > 0) {
              const { error: messInsErr } = await supabase.from("notifications").insert(messNotifications);
              if (!messInsErr) {
                messSent = messNotifications.length;
                for (const p of validMessPayloads) {
                  if (p.mess_members?.phone) {
                    const resp = await fetchFn(`${supabaseUrl}/functions/v1/twilio-notifications`, {
                      method: "POST",
                      headers: dispatchHeaders,
                      body: JSON.stringify({
                        action: "send-mess-reminder",
                        member_phone: p.mess_members.phone,
                        member_name: p.mess_members.full_name || "Member",
                        amount: p.final_amount,
                        month: currentMonth,
                        mess_name: p.mess_members.mess_plans?.name || "Your PG Mess",
                      }),
                    });
                    if (!resp.ok) {
                      console.warn(`WhatsApp mess reminder returned HTTP ${resp.status}`);
                    }
                  }
                }
              }
            }
          }
        }
      } catch (e: unknown) {
        console.error("Mess reminders error:", e instanceof Error ? e.message : String(e));
      }

      return jsonResponse(
        {
          message: `Cron executed. Dispatched ${sent} rent reminders & ${messSent} mess reminders.`,
          rent_sent: sent,
          mess_sent: messSent,
        },
        200,
        corsHeaders,
      );
    } catch (err) {
      if (err instanceof ConfigError) {
        return jsonResponse({ error: err.message }, err.status, corsHeaders);
      }
      console.error("Unexpected rent-reminders error:", err);
      return jsonResponse({ error: "Internal server error" }, 500, corsHeaders);
    }
  };
}
