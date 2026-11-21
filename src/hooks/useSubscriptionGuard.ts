import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useStaffAccess } from "@/hooks/useStaffAccess";
import { useSubscriptionPlan } from "@/hooks/useSubscriptionPlan";

/** Total beds (room capacity) across every property of one owner: what the plan limit counts. */
export async function fetchBedCount(ownerId: string): Promise<number> {
  const { data: ownerProps, error } = await supabase.from("properties").select("id").eq("owner_id", ownerId);
  if (error) throw error;
  const propIds = (ownerProps ?? []).map((p) => p.id);
  if (propIds.length === 0) return 0;
  const { data: rooms, error: roomsError } = await supabase.from("rooms").select("capacity").in("property_id", propIds);
  if (roomsError) throw roomsError;
  return (rooms ?? []).reduce((sum, r) => sum + (r.capacity || 0), 0);
}

export const bedCountKey = (ownerId: string | null) => ["bed-count", ownerId] as const;

export const useSubscriptionGuard = () => {
  const { effectiveOwnerId, loading: staffLoading } = useStaffAccess();
  const { planSlug, limits, loading: planLoading } = useSubscriptionPlan(effectiveOwnerId);
  const queryClient = useQueryClient();

  // Cached: five pages and their layout ask for this, and it used to cost 2 requests per page visit.
  const query = useQuery({
    queryKey: bedCountKey(effectiveOwnerId),
    queryFn: () => fetchBedCount(effectiveOwnerId as string),
    enabled: !!effectiveOwnerId && !staffLoading,
  });
  const bedCount = query.data ?? 0;

  // Call this after adding/removing beds to force a recount
  const refetchBedCount = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: bedCountKey(effectiveOwnerId) });
  }, [queryClient, effectiveOwnerId]);

  const bedLimit = limits.tenantLimit;
  const isOverLimit = bedLimit !== Infinity && bedCount > bedLimit;
  const isReadOnly = isOverLimit;
  const isBedLimitReached = bedLimit !== Infinity && bedCount >= bedLimit;

  return {
    planSlug,
    limits,
    bedCount,
    bedLimit,
    isOverLimit,
    isReadOnly,
    isBedLimitReached,
    refetchBedCount,
    loading: (!!effectiveOwnerId && query.isPending) || planLoading || staffLoading,
  };
};
