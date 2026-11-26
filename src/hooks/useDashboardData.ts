import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export interface DashboardStats {
  properties: number;
  rooms: number;
  tenants: number;
  pendingPayments: number;
  complaints: number;
  pendingRevenue: number;
  collectedRevenue: number;
  totalExpenses: number;
  vacancyNotices: number;
}

export interface RecentComplaint { id: string; title: string; status: string; category: string; created_at: string }

export interface DashboardData {
  stats: DashboardStats;
  recentComplaints: RecentComplaint[];
  occupancy: { occupied: number; vacant: number };
  expensesByCategory: { name: string; value: number }[];
  monthlyPayments: { month: string; collected: number; pending: number }[];
}

const EMPTY: DashboardData = {
  stats: { properties: 0, rooms: 0, tenants: 0, pendingPayments: 0, complaints: 0, pendingRevenue: 0, collectedRevenue: 0, totalExpenses: 0, vacancyNotices: 0 },
  recentComplaints: [],
  occupancy: { occupied: 0, vacant: 0 },
  expensesByCategory: [],
  monthlyPayments: [],
};

/** Every dashboard query key starts with this. Invalidate it after anything that changes money, rooms or tenants. */
export const dashboardKey = ["dashboard"] as const;

/** A failed read throws, so the page shows an error instead of zeros ("Setup Your PG" to an owner who has PGs). */
function rowsOf<T>(res: { data: T[] | null; error: { message: string } | null }, what: string): T[] {
  if (res.error) throw new Error(`Could not load ${what}: ${res.error.message}`);
  return res.data ?? [];
}

export async function fetchDashboardData(propIds: string[], fromISO: string, toISO: string): Promise<DashboardData> {
  if (propIds.length === 0) return EMPTY;

  const [propRes, roomRes, tenantRes, pendingPayRes, paidPayRes, complaintRes, expRes, noticeRes, recentCompRes] = await Promise.all([
    supabase.from("properties").select("id", { count: "exact", head: true }).in("id", propIds),
    supabase.from("rooms").select("id, is_vacant, capacity, property_id").in("property_id", propIds),
    supabase.from("tenant_assignments").select("id, property_id").in("property_id", propIds).eq("is_active", true),
    supabase.from("rent_payments").select("id, amount, month, property_id").in("property_id", propIds).eq("status", "pending").gte("created_at", fromISO).lte("created_at", toISO),
    supabase.from("rent_payments").select("id, amount, month, property_id").in("property_id", propIds).eq("status", "paid").gte("created_at", fromISO).lte("created_at", toISO),
    supabase.from("complaints").select("id, property_id").in("property_id", propIds).eq("status", "open").gte("created_at", fromISO).lte("created_at", toISO),
    supabase.from("expenses").select("amount, category, property_id").in("property_id", propIds).gte("created_at", fromISO).lte("created_at", toISO),
    supabase.from("vacancy_notices").select("id, property_id").in("property_id", propIds).eq("status", "submitted"),
    supabase.from("complaints").select("id, title, status, category, created_at, property_id").in("property_id", propIds).gte("created_at", fromISO).lte("created_at", toISO).order("created_at", { ascending: false }).limit(5),
  ]);

  if (propRes.error) throw new Error(`Could not load properties: ${propRes.error.message}`);
  const rooms = rowsOf(roomRes, "rooms");
  const tenants = rowsOf(tenantRes, "tenants");
  const pendingPay = rowsOf(pendingPayRes, "pending payments");
  const paidPay = rowsOf(paidPayRes, "payments");
  const openComplaints = rowsOf(complaintRes, "complaints");
  const expenses = rowsOf(expRes, "expenses");
  const notices = rowsOf(noticeRes, "vacancy notices");
  const recentComplaints = rowsOf(recentCompRes, "recent complaints") as RecentComplaint[];

  const catMap: Record<string, number> = {};
  for (const e of expenses) catMap[e.category] = (catMap[e.category] || 0) + Number(e.amount);

  const monthMap: Record<string, { collected: number; pending: number }> = {};
  for (const p of paidPay) (monthMap[p.month] ??= { collected: 0, pending: 0 }).collected += Number(p.amount);
  for (const p of pendingPay) (monthMap[p.month] ??= { collected: 0, pending: 0 }).pending += Number(p.amount);

  // Occupancy: bed capacity against active tenants.
  const totalBeds = rooms.reduce((sum, r) => sum + (r.capacity ?? 1), 0);

  return {
    stats: {
      properties: propRes.count ?? 0,
      rooms: rooms.length,
      tenants: tenants.length,
      pendingPayments: pendingPay.length,
      complaints: openComplaints.length,
      pendingRevenue: pendingPay.reduce((s, p) => s + Number(p.amount), 0),
      collectedRevenue: paidPay.reduce((s, p) => s + Number(p.amount), 0),
      totalExpenses: expenses.reduce((s, e) => s + Number(e.amount), 0),
      vacancyNotices: notices.length,
    },
    recentComplaints,
    occupancy: { occupied: tenants.length, vacant: Math.max(0, totalBeds - tenants.length) },
    expensesByCategory: Object.entries(catMap).map(([name, value]) => ({ name, value })),
    monthlyPayments: Object.entries(monthMap)
      .map(([month, data]) => ({ month, ...data }))
      .sort((a, b) => a.month.localeCompare(b.month))
      .slice(-6),
  };
}

interface Options {
  ownerId: string | null;
  /** From useStaffAccess: the properties this user may see. */
  accessiblePropertyIds: string[];
  /** A staff member assigned to one property only sees that one. */
  staffPropertyId: string | null;
  /** "all" or one property id from the filter dropdown. */
  filterPropertyId: string;
  range: { from: Date; to: Date };
  /** False until access is known: never read with a half-known user. */
  enabled: boolean;
}

/**
 * The owner dashboard's numbers, cached per owner + property filter + date range.
 * The property-name list and the stats are read at the same time (the ids come from useStaffAccess),
 * so there is no waterfall. Stats are money, so they are always refetched when the page opens, but the
 * last numbers are shown meanwhile instead of a blank page.
 */
export function useDashboardData({ ownerId, accessiblePropertyIds, staffPropertyId, filterPropertyId, range, enabled }: Options) {
  const propIds = staffPropertyId ? [staffPropertyId] : filterPropertyId !== "all" ? [filterPropertyId] : accessiblePropertyIds;
  const fromISO = range.from.toISOString();
  const toISO = range.to.toISOString();

  const names = useQuery({
    queryKey: [...dashboardKey, "property-names", ownerId],
    queryFn: async () => {
      const { data, error } = await supabase.from("properties").select("id, name").eq("owner_id", ownerId as string);
      if (error) throw new Error(`Could not load properties: ${error.message}`);
      return (data ?? []) as { id: string; name: string }[];
    },
    enabled: enabled && !!ownerId,
    staleTime: 5 * 60_000,
  });

  const stats = useQuery({
    queryKey: [...dashboardKey, "stats", ownerId, [...propIds].sort().join(","), fromISO, toISO],
    queryFn: () => fetchDashboardData(propIds, fromISO, toISO),
    enabled: enabled && !!ownerId,
    staleTime: 0,
    refetchOnMount: "always",
    // Changing the filter or the dates keeps the old numbers on screen until the new ones arrive.
    placeholderData: keepPreviousData,
  });

  return {
    data: stats.data,
    properties: names.data ?? [],
    /** True only when there is nothing to show yet (first visit). A revisit shows cached numbers. */
    isLoading: stats.isPending && stats.fetchStatus !== "idle",
    isFetching: stats.isFetching,
    isError: stats.isError,
    error: stats.error,
    refetch: stats.refetch,
  };
}
