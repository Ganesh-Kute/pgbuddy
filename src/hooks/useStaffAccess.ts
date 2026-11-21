import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";

interface StaffAccess {
  /** Whether the current user is a staff member (not the property owner) */
  isStaff: boolean;
  /** The owner ID whose properties this staff can access (or the user's own ID if they're the owner) */
  effectiveOwnerId: string | null;
  /** The staff role (manager, accountant, caretaker) — null if user is the actual owner */
  staffRole: string | null;
  /** The single property_id this staff is assigned to (null = all properties, or user is owner) */
  staffPropertyId: string | null;
  /** Property IDs this user can access (own properties + staff-assigned properties) */
  accessiblePropertyIds: string[];
  /** True until the signed-in user and their access are both known. Never fetch while true. */
  loading: boolean;
}

export type ResolvedAccess = Omit<StaffAccess, "loading">;

const NO_ACCESS: ResolvedAccess = {
  isStaff: false,
  effectiveOwnerId: null,
  staffRole: null,
  staffPropertyId: null,
  accessiblePropertyIds: [],
};

/** One staff_members row is enough: a user works for one owner at a time. */
export async function fetchStaffAccess(userId: string, isStaff: boolean): Promise<ResolvedAccess> {
  if (isStaff) {
    const { data: staff, error } = await supabase
      .from("staff_members")
      .select("owner_id, role, property_id")
      .eq("staff_user_id", userId)
      .eq("status", "active")
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (staff) {
      const { data: propIds, error: rpcError } = await supabase.rpc("get_staff_property_ids", { _user_id: userId });
      if (rpcError) throw rpcError;
      return {
        isStaff: true,
        effectiveOwnerId: staff.owner_id,
        staffRole: staff.role,
        staffPropertyId: staff.property_id ?? null,
        accessiblePropertyIds: propIds ?? [],
      };
    }
    // The staff row went away since sign-in: fall through and treat the user as an owner.
  }

  const { data: own, error } = await supabase.from("properties").select("id").eq("owner_id", userId);
  if (error) throw error;
  return { ...NO_ACCESS, effectiveOwnerId: userId, accessiblePropertyIds: (own ?? []).map((p) => p.id) };
}

/** Query key for a user's access. Invalidate it after creating or deleting a property. */
export const staffAccessKey = (userId: string | null | undefined) => ["staff-access", userId ?? null] as const;

/**
 * Unified property access for both owners and staff members.
 * - For owners: their own user ID and their own property IDs.
 * - For staff: the owner's ID and the staff-assigned property IDs.
 *
 * Cached per user and shared by every page and the layout, so a sidebar click does not refetch it.
 * Use `effectiveOwnerId` when querying `properties.owner_id`.
 * Use `accessiblePropertyIds` when filtering by property_id.
 */
export const useStaffAccess = (): StaffAccess => {
  const { user, isStaff: authIsStaff, loading: authLoading } = useAuth();
  const userId = user?.id ?? null;

  const query = useQuery({
    queryKey: [...staffAccessKey(userId), authIsStaff],
    queryFn: () => fetchStaffAccess(userId as string, authIsStaff),
    enabled: !!userId && !authLoading,
    staleTime: 5 * 60_000,
  });

  if (!userId) return { ...NO_ACCESS, loading: authLoading };
  if (authLoading || query.isPending) return { ...NO_ACCESS, loading: true };
  if (query.isError) {
    // Fail closed: no properties. Owners still get their own id so their own rows load under RLS.
    console.error("Could not load property access:", query.error);
    return { ...NO_ACCESS, effectiveOwnerId: authIsStaff ? null : userId, loading: false };
  }
  return { ...query.data, loading: false };
};
