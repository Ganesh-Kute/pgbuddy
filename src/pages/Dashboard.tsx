import { lazy, Suspense, useState } from "react";
import { Building2, Users, Home, CreditCard, TrendingUp, AlertCircle, IndianRupee, Receipt, Plus, ArrowRight, MessageSquare, BellDot, Filter, CalendarIcon } from "lucide-react";
import { endOfDay, format, startOfDay, subDays, subMonths } from "date-fns";
import { cn } from "@/lib/utils";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Link } from "react-router-dom";
import DashboardLayout from "@/components/dashboard/DashboardLayout";
import { Separator } from "@/components/ui/separator";
import { useSubscriptionGuard } from "@/hooks/useSubscriptionGuard";
import OverLimitBanner from "@/components/OverLimitBanner";
import { useStaffAccess, staffAccessKey } from "@/hooks/useStaffAccess";
import { useQueryClient } from "@tanstack/react-query";
import { useDashboardData } from "@/hooks/useDashboardData";

// Charts load after the numbers: the chart library is the biggest download in the app.
const DashboardCharts = lazy(() => import("@/components/dashboard/DashboardCharts"));

type PresetKey = "last30" | "last3m" | "last6m" | "last12m" | "custom";

const presets: { key: PresetKey; label: string }[] = [
  { key: "last30", label: "Last 30 days" },
  { key: "last3m", label: "Last 3 months" },
  { key: "last6m", label: "Last 6 months" },
  { key: "last12m", label: "Last 12 months" },
  { key: "custom", label: "Custom range" },
];

// Whole days, not "now": the range is part of the dashboard's cache key, so it must be the same on every
// visit during a day. With `to: now` each visit got a new key: a cache miss and a blank page every time.
const getPresetRange = (key: PresetKey): { from: Date; to: Date } => {
  const now = new Date();
  const to = endOfDay(now);
  switch (key) {
    case "last30": return { from: startOfDay(subDays(now, 30)), to };
    case "last3m": return { from: startOfDay(subMonths(now, 3)), to };
    case "last6m": return { from: startOfDay(subMonths(now, 6)), to };
    case "last12m": return { from: startOfDay(subMonths(now, 12)), to };
    default: return { from: startOfDay(subMonths(now, 3)), to };
  }
};

const NO_DATA = {
  stats: { properties: 0, rooms: 0, tenants: 0, pendingPayments: 0, complaints: 0, pendingRevenue: 0, collectedRevenue: 0, totalExpenses: 0, vacancyNotices: 0 },
  recentComplaints: [] as { id: string; title: string; status: string; category: string; created_at: string }[],
  occupancy: { occupied: 0, vacant: 0 },
  expensesByCategory: [] as { name: string; value: number }[],
  monthlyPayments: [] as { month: string; collected: number; pending: number }[],
};

const Dashboard = () => {
  const { isOverLimit, bedCount, bedLimit, limits } = useSubscriptionGuard();
  const { effectiveOwnerId, isStaff, staffPropertyId, accessiblePropertyIds, loading: staffLoading, failed: accessFailed } = useStaffAccess();
  const queryClient = useQueryClient();
  const [filterPropertyId, setFilterPropertyId] = useState<string>("all");

  const [activePreset, setActivePreset] = useState<PresetKey>("last3m");
  const [dateRange, setDateRange] = useState(getPresetRange("last3m"));
  const [customFrom, setCustomFrom] = useState<Date | undefined>(undefined);
  const [customTo, setCustomTo] = useState<Date | undefined>(undefined);

  const handlePreset = (key: PresetKey) => {
    setActivePreset(key);
    if (key !== "custom") {
      setDateRange(getPresetRange(key));
    }
  };

  const applyCustomRange = () => {
    if (customFrom && customTo) {
      setDateRange({ from: customFrom, to: customTo });
    }
  };
  const dashboard = useDashboardData({
    ownerId: effectiveOwnerId,
    accessiblePropertyIds,
    staffPropertyId: isStaff ? staffPropertyId : null,
    filterPropertyId,
    range: dateRange,
    // An unknown property list must not be read as "no properties" (that showed 'Setup Your PG' offline).
    enabled: !staffLoading && !accessFailed,
  });
  const loadFailed = accessFailed || (dashboard.isError && !dashboard.data);
  const retryLoad = () => {
    // Every access entry (the key is the signed-in user, which this page does not hold).
    if (accessFailed) queryClient.invalidateQueries({ queryKey: staffAccessKey(null).slice(0, 1) });
    else dashboard.refetch();
  };
  const { properties } = dashboard;
  const { stats, recentComplaints, occupancy, expensesByCategory, monthlyPayments } = dashboard.data ?? NO_DATA;
  /** True only on a first visit with nothing to show yet; a revisit shows the cached numbers at once. */
  const dataLoading = staffLoading || dashboard.isLoading;

  const profit = stats.collectedRevenue - stats.totalExpenses;
  const isNewOwner = stats.properties === 0;

  // Onboarding steps
  const onboardingSteps = [
    { done: stats.properties > 0, label: "Add your first property", link: "/dashboard/properties", icon: Building2 },
    { done: stats.rooms > 0, label: "Create rooms with pricing", link: "/dashboard/rooms", icon: Home },
    { done: stats.tenants > 0, label: "Assign your first tenant", link: "/dashboard/tenants", icon: Users },
    { done: stats.pendingPayments > 0 || stats.collectedRevenue > 0, label: "Generate monthly rent", link: "/dashboard/payments", icon: CreditCard },
  ];

  const completedSteps = onboardingSteps.filter(s => s.done).length;

  return (
    <DashboardLayout>
      <div className="space-y-6">
        {isOverLimit && (
          <OverLimitBanner bedCount={bedCount} bedLimit={bedLimit} planName={limits.name} />
        )}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">Dashboard</h1>
            <p className="text-muted-foreground">Welcome back! Here's your PG overview.</p>
          </div>
          <div className="hidden sm:flex items-center gap-2">
            {/* Property filter for owners, auto-locked for staff */}
            {!isStaff && properties.length > 1 && (
              <Select value={filterPropertyId} onValueChange={setFilterPropertyId}>
                <SelectTrigger className="w-[180px] h-9">
                  <Filter className="w-3.5 h-3.5 mr-1.5 text-muted-foreground" />
                  <SelectValue placeholder="All Properties" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Properties</SelectItem>
                  {properties.map(p => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
                </SelectContent>
              </Select>
            )}
            {isStaff && staffPropertyId && (
              <Badge variant="outline" className="h-9 px-3 flex items-center gap-1.5">
                <Building2 className="w-3.5 h-3.5" />
                {properties.find(p => p.id === staffPropertyId)?.name || "Assigned Property"}
              </Badge>
            )}
            <Button variant="outline" size="sm" asChild>
              <Link to="/dashboard/payments"><CreditCard className="w-4 h-4 mr-1" /> Payments</Link>
            </Button>
            <Button size="sm" className="gradient-primary" asChild>
              <Link to="/dashboard/properties"><Plus className="w-4 h-4 mr-1" /> Add Property</Link>
            </Button>
          </div>
        </div>

        {/* Date Range Filters */}
        <Card>
          <CardContent className="pt-4 pb-4">
            <div className="flex flex-wrap items-center gap-2">
              {presets.map(p => (
                <Button
                  key={p.key}
                  size="sm"
                  variant={activePreset === p.key ? "default" : "outline"}
                  onClick={() => handlePreset(p.key)}
                  className={activePreset === p.key ? "gradient-primary" : ""}
                >
                  {p.label}
                </Button>
              ))}

              {activePreset === "custom" && (
                <div className="flex flex-wrap items-center gap-2 ml-2">
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button variant="outline" size="sm" className={cn("gap-1.5", !customFrom && "text-muted-foreground")}>
                        <CalendarIcon className="w-3.5 h-3.5" />
                        {customFrom ? format(customFrom, "MMM d, yyyy") : "From"}
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-auto p-0" align="start">
                      <Calendar
                        mode="single"
                        selected={customFrom}
                        onSelect={setCustomFrom}
                        disabled={(date: Date) => date > new Date()}
                        initialFocus
                        className={cn("p-3 pointer-events-auto")}
                      />
                    </PopoverContent>
                  </Popover>
                  <span className="text-muted-foreground text-sm">→</span>
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button variant="outline" size="sm" className={cn("gap-1.5", !customTo && "text-muted-foreground")}>
                        <CalendarIcon className="w-3.5 h-3.5" />
                        {customTo ? format(customTo, "MMM d, yyyy") : "To"}
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-auto p-0" align="start">
                      <Calendar
                        mode="single"
                        selected={customTo}
                        onSelect={setCustomTo}
                        disabled={(date: Date) => date > new Date() || (customFrom ? date < customFrom : false)}
                        initialFocus
                        className={cn("p-3 pointer-events-auto")}
                      />
                    </PopoverContent>
                  </Popover>
                  <Button size="sm" onClick={applyCustomRange} disabled={!customFrom || !customTo}>
                    Apply
                  </Button>
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        {loadFailed && (
          <Card className="border-destructive/50">
            <CardContent className="pt-6 flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm">Could not load your dashboard numbers. Check your connection and try again.</p>
              <Button variant="outline" size="sm" onClick={retryLoad}>Retry</Button>
            </CardContent>
          </Card>
        )}

        {/* Onboarding progress - show if not fully set up, and only once the real numbers are known */}
        {dashboard.data && !loadFailed && completedSteps < 4 && (
          <Card className="border-primary/20 bg-primary/5">
            <CardContent className="pt-6">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h3 className="font-semibold">Setup Your PG</h3>
                  <p className="text-sm text-muted-foreground">{completedSteps}/4 steps completed</p>
                </div>
                <div className="h-2 w-24 rounded-full bg-muted overflow-hidden">
                  <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${(completedSteps / 4) * 100}%` }} />
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                {onboardingSteps.map((step, i) => (
                  <Link
                    key={i}
                    to={step.link}
                    className={`flex items-center gap-3 p-3 rounded-lg transition-colors ${
                      step.done ? "bg-success/10 text-success" : "bg-card hover:bg-muted"
                    }`}
                  >
                    <step.icon className="w-4 h-4 shrink-0" />
                    <span className={`text-sm ${step.done ? "line-through" : "font-medium"}`}>{step.label}</span>
                    {!step.done && <ArrowRight className="w-3 h-3 ml-auto" />}
                  </Link>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Stat Cards */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {[
            { label: "Properties", value: stats.properties, icon: Building2, color: "text-primary", link: "/dashboard/properties" },
            { label: "Total Rooms", value: stats.rooms, icon: Home, color: "text-primary", link: "/dashboard/rooms" },
            { label: "Active Tenants", value: stats.tenants, icon: Users, color: "text-primary", link: "/dashboard/tenants" },
            { label: "Open Complaints", value: stats.complaints, icon: AlertCircle, color: "text-destructive", link: "/dashboard/complaints" },
          ].map((stat, i) => (
            <div key={stat.label} className="animate-in fade-in slide-in-from-bottom-2 fill-mode-both duration-300" style={{ animationDelay: `${i * 50}ms` }}>
              <Link to={stat.link}>
                <Card className="hover:shadow-md transition-shadow cursor-pointer">
                  <CardHeader className="flex flex-row items-center justify-between pb-2">
                    <CardTitle className="text-sm font-medium text-muted-foreground">{stat.label}</CardTitle>
                    <stat.icon className={`w-5 h-5 ${stat.color}`} />
                  </CardHeader>
                  <CardContent>
                    <p className="text-2xl font-bold">{stat.value}</p>
                  </CardContent>
                </Card>
              </Link>
            </div>
          ))}
        </div>

        {/* Financial Summary */}
        <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Collected</CardTitle>
              <TrendingUp className="w-5 h-5 text-success" />
            </CardHeader>
            <CardContent>
              <p className="text-xl font-bold flex items-center gap-0.5">
                <IndianRupee className="w-4 h-4" />{stats.collectedRevenue.toLocaleString()}
              </p>
            </CardContent>
          </Card>
          <Card className={stats.pendingRevenue > 0 ? "border-warning/50" : ""}>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Pending</CardTitle>
              <CreditCard className="w-5 h-5 text-warning" />
            </CardHeader>
            <CardContent>
              <p className="text-xl font-bold flex items-center gap-0.5">
                <IndianRupee className="w-4 h-4" />{stats.pendingRevenue.toLocaleString()}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Expenses</CardTitle>
              <Receipt className="w-5 h-5 text-destructive" />
            </CardHeader>
            <CardContent>
              <p className="text-xl font-bold flex items-center gap-0.5">
                <IndianRupee className="w-4 h-4" />{stats.totalExpenses.toLocaleString()}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Net Profit</CardTitle>
              <TrendingUp className="w-5 h-5 text-primary" />
            </CardHeader>
            <CardContent>
              <p className={`text-xl font-bold flex items-center gap-0.5 ${profit < 0 ? "text-destructive" : ""}`}>
                <IndianRupee className="w-4 h-4" />{profit.toLocaleString()}
              </p>
            </CardContent>
          </Card>
        </div>

        {/* Alerts Row */}
        {(stats.vacancyNotices > 0 || stats.complaints > 0) && (
          <div className="flex flex-wrap gap-3">
            {stats.vacancyNotices > 0 && (
              <Link to="/dashboard/notices">
                <Badge variant="secondary" className="bg-warning/10 text-warning px-3 py-1.5 cursor-pointer hover:bg-warning/20 transition-colors">
                  <BellDot className="w-3 h-3 mr-1.5" />{stats.vacancyNotices} vacancy notice{stats.vacancyNotices > 1 ? "s" : ""} pending
                </Badge>
              </Link>
            )}
            {stats.complaints > 0 && (
              <Link to="/dashboard/complaints">
                <Badge variant="secondary" className="bg-destructive/10 text-destructive px-3 py-1.5 cursor-pointer hover:bg-destructive/20 transition-colors">
                  <MessageSquare className="w-3 h-3 mr-1.5" />{stats.complaints} open complaint{stats.complaints > 1 ? "s" : ""}
                </Badge>
              </Link>
            )}
          </div>
        )}

        {/* Charts Row: loaded after the numbers. The fallback keeps the same height, so nothing jumps. */}
        <Suspense fallback={<div className="grid grid-cols-1 lg:grid-cols-2 gap-6" aria-hidden="true"><div className="h-[300px] rounded-lg border bg-card" /><div className="h-[300px] rounded-lg border bg-card" /></div>}>
          <DashboardCharts monthlyPayments={monthlyPayments} expensesByCategory={expensesByCategory} />
        </Suspense>

        {/* Occupancy + Recent Complaints */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Occupancy */}
          {stats.rooms > 0 && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Occupancy Rate</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex items-center gap-4 mb-3">
                  <div className="flex-1">
                    <div className="h-3 rounded-full bg-muted overflow-hidden">
                      <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${((occupancy.occupied) / (occupancy.occupied + occupancy.vacant || 1)) * 100}%` }} />
                    </div>
                  </div>
                  <span className="text-lg font-bold">{Math.round((occupancy.occupied / (occupancy.occupied + occupancy.vacant || 1)) * 100)}%</span>
                </div>
                <div className="flex gap-4 text-sm">
                  <Badge variant="default">{occupancy.occupied} Occupied Beds</Badge>
                  <Badge variant="secondary">{occupancy.vacant} Vacant Beds</Badge>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Recent Complaints */}
          <Card>
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base">Recent Complaints</CardTitle>
                <Button variant="ghost" size="sm" className="text-xs" asChild>
                  <Link to="/dashboard/complaints">View All</Link>
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              {recentComplaints.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-6">No complaints — all clear! 🎉</p>
              ) : (
                <div className="space-y-3">
                  {recentComplaints.slice(0, 4).map(c => (
                    <div key={c.id} className="flex items-center justify-between">
                      <div>
                        <p className="text-sm font-medium">{c.title}</p>
                        <p className="text-xs text-muted-foreground capitalize">{c.category} · {new Date(c.created_at).toLocaleDateString()}</p>
                      </div>
                      <Badge variant="secondary" className={`text-xs ${c.status === "resolved" ? "bg-success/10 text-success" : c.status === "open" ? "bg-destructive/10 text-destructive" : "bg-warning/10 text-warning"}`}>
                        {c.status}
                      </Badge>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </DashboardLayout>
  );
};

export default Dashboard;
