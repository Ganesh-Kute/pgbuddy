import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import type { WhatsAppAction } from "@/hooks/useWhatsAppNotify";

export type PlanSlug = "free" | "pro" | "business" | "enterprise";

export interface PlanLimits {
  slug: PlanSlug;
  name: string;
  maxPhotos: number;
  videoTour: boolean;
  enquiryAnalytics: boolean;
  featuredBadge: boolean;
  tenantLimit: number;
}

const PLAN_LIMITS: Record<PlanSlug, PlanLimits> = {
  free: {
    slug: "free",
    name: "Free",
    maxPhotos: 3,
    videoTour: false,
    enquiryAnalytics: false,
    featuredBadge: false,
    tenantLimit: 5,
  },
  pro: {
    slug: "pro",
    name: "Pro",
    maxPhotos: 10,
    videoTour: true,
    enquiryAnalytics: false,
    featuredBadge: false,
    tenantLimit: 50,
  },
  business: {
    slug: "business",
    name: "Business",
    maxPhotos: Infinity,
    videoTour: true,
    enquiryAnalytics: true,
    featuredBadge: true,
    tenantLimit: 100,
  },
  enterprise: {
    slug: "enterprise",
    name: "Enterprise",
    maxPhotos: Infinity,
    videoTour: true,
    enquiryAnalytics: true,
    featuredBadge: true,
    tenantLimit: Infinity,
  },
};

export type { WhatsAppAction };

/** Actions that require Business or Enterprise plan */
const GATED_WA_ACTIONS: WhatsAppAction[] = [
  "send-announcement",
  "send-complaint-alert",
  "send-vacancy-alert",
  "send-mess-reminder",
];

/** The active plan of one user. A plan whose period has ended counts as free. */
export async function fetchPlanSlug(userId: string): Promise<PlanSlug> {
  const { data, error } = await supabase
    .from("subscriptions")
    .select("subscription_plans(slug), status, current_period_end")
    .eq("user_id", userId)
    .eq("status", "active")
    .maybeSingle();
  if (error) throw error;
  if (!data) return "free";
  if (data.current_period_end && new Date(data.current_period_end) < new Date()) return "free";
  const slug = data.subscription_plans?.slug as PlanSlug | undefined;
  return slug && slug in PLAN_LIMITS ? slug : "free";
}

export const useSubscriptionPlan = (ownerId?: string | null) => {
  const { user } = useAuth();
  const targetUserId = ownerId || user?.id || null;
  // Cached per user: the layout, the guard and the page all ask, and it used to be fetched by each.
  const query = useQuery({
    queryKey: ["subscription-plan", targetUserId],
    queryFn: () => fetchPlanSlug(targetUserId as string),
    enabled: !!targetUserId,
    staleTime: 5 * 60_000,
  });
  const planSlug: PlanSlug = query.data ?? "free";
  const loading = !!targetUserId && query.isPending;

  const isBusiness = planSlug === "business" || planSlug === "enterprise";

  /** Returns true if the current plan allows the given WhatsApp action */
  const canUseWhatsApp = (action: WhatsAppAction): boolean => {
    if (!GATED_WA_ACTIONS.includes(action)) return true; // rent reminders → always OK
    return isBusiness;
  };

  return {
    planSlug,
    limits: PLAN_LIMITS[planSlug],
    loading,
    isPro: planSlug === "pro" || isBusiness,
    isBusiness,
    isEnterprise: planSlug === "enterprise",
    canUseWhatsApp,
  };
};
