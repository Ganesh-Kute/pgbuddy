import { useState, useEffect } from "react";
import { Link, useNavigate, useLocation } from "react-router-dom";
import {
  Building2, Home, Users, CreditCard, BarChart3, Receipt,
  LogOut, Menu, X, MessageSquare, Megaphone, QrCode, User, Crown, UtensilsCrossed,
  UserCheck, Zap, PieChart, Activity, ShieldCheck, DoorOpen, MoreHorizontal,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useAuth } from "@/hooks/useAuth";
import { useStaffAccess } from "@/hooks/useStaffAccess";
import { supabase } from "@/integrations/supabase/client";
import { useLanguage } from "@/i18n/LanguageContext";
import LanguageSwitcher from "@/components/LanguageSwitcher";
import ThemeToggle from "@/components/ThemeToggle";
import { getAppName, getAppLogo, isWhiteLabel } from "@/lib/branding";

interface SubscriptionPlanJoin {
  subscription_plans?: { name?: string | null } | null;
}

const getSidebarLinks = (t: (k: string) => string) => [
  { name: t("sidebar.overview"), href: "/dashboard", icon: BarChart3 },
  { name: t("sidebar.properties"), href: "/dashboard/properties", icon: Building2 },
  { name: t("sidebar.rooms"), href: "/dashboard/rooms", icon: Home },
  { name: t("sidebar.tenants"), href: "/dashboard/tenants", icon: Users },
  { name: t("sidebar.payments"), href: "/dashboard/payments", icon: CreditCard },
  { name: t("sidebar.paymentSetup"), href: "/dashboard/payment-settings", icon: QrCode },
  { name: t("sidebar.expenses"), href: "/dashboard/expenses", icon: Receipt },
  { name: t("sidebar.complaints"), href: "/dashboard/complaints", icon: MessageSquare },
  { name: t("sidebar.announcements"), href: "/dashboard/announcements", icon: Megaphone },
  { name: "Mess Management", href: "/dashboard/mess", icon: UtensilsCrossed },
  { name: "Visitor Log", href: "/dashboard/visitors", icon: UserCheck },
  { name: "Utility Bills", href: "/dashboard/utility-bills", icon: Zap },
  { name: "Analytics", href: "/dashboard/analytics", icon: PieChart },
  { name: "Activity Log", href: "/dashboard/audit-logs", icon: Activity },
  { name: "Move-Out", href: "/dashboard/move-out", icon: DoorOpen },
  { name: "Staff", href: "/dashboard/staff", icon: ShieldCheck },
];

const DashboardLayout = ({ children }: { children: React.ReactNode }) => {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const { signOut, user } = useAuth();
  const { isStaff, effectiveOwnerId } = useStaffAccess();
  const navigate = useNavigate();
  const location = useLocation();
  const { t } = useLanguage();
  const [currentPlan, setCurrentPlan] = useState<string>("Free");

  const sidebarLinks = getSidebarLinks(t).filter((link) => !(isStaff && link.name === "Staff"));
  const currentPath = location.pathname;

  const mobileBottomLinks = [
    { name: t("sidebar.overview"), href: "/dashboard", icon: BarChart3 },
    { name: t("sidebar.properties"), href: "/dashboard/properties", icon: Building2 },
    { name: t("sidebar.tenants"), href: "/dashboard/tenants", icon: Users },
    { name: t("sidebar.payments"), href: "/dashboard/payments", icon: CreditCard },
  ];

  useEffect(() => {
    const targetId = effectiveOwnerId || user?.id;
    if (!targetId) return;
    const fetchPlan = async () => {
      const { data } = await supabase
        .from("subscriptions")
        .select("subscription_plans(name)")
        .eq("user_id", targetId)
        .eq("status", "active")
        .maybeSingle();
      const planName = (data as SubscriptionPlanJoin | null)?.subscription_plans?.name;
      if (planName) {
        setCurrentPlan(planName);
      }
    };
    fetchPlan();
  }, [user, effectiveOwnerId]);

  const handleSignOut = async () => {
    await signOut();
    navigate("/");
  };

  const NavLinks = ({ onClick }: { onClick?: () => void }) => (
    <>
      <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
        {sidebarLinks.map((link) => {
          const isActive = currentPath === link.href;
          return (
            <Link
              key={link.name}
              to={link.href}
              onClick={onClick}
              className={`flex items-center gap-3 px-3 min-h-[44px] lg:min-h-0 py-2.5 lg:py-2 rounded-xl text-sm font-medium transition-colors duration-200 ${
                isActive
                  ? "gradient-primary text-primary-foreground shadow-sm"
                  : "text-muted-foreground hover:bg-muted/80 hover:text-foreground"
              }`}
            >
              <link.icon className="w-4 h-4 shrink-0" />
              <span className="truncate">{link.name}</span>
            </Link>
          );
        })}
      </nav>
      <div className="px-3 py-4 border-t border-border/50 space-y-1">
        {!isStaff && !isWhiteLabel && (
          <Link
            to="/dashboard/subscription"
            onClick={onClick}
            className={`flex items-center justify-between px-3 min-h-[44px] lg:min-h-0 py-2.5 lg:py-2 rounded-xl text-sm font-medium transition-colors duration-200 ${
              currentPath === "/dashboard/subscription"
                ? "gradient-primary text-primary-foreground shadow-sm"
                : "text-muted-foreground hover:bg-muted/80 hover:text-foreground"
            }`}
          >
            <span className="flex items-center gap-3">
              <Crown className="w-4 h-4" />
              {t("sidebar.subscription")}
            </span>
            <Badge
              variant="secondary"
              className={`text-[10px] px-1.5 py-0 ${
                currentPlan === "Free"
                  ? "bg-muted text-muted-foreground"
                  : currentPlan === "Pro"
                  ? "bg-primary/10 text-primary"
                  : "bg-warning/10 text-warning"
              }`}
            >
              {currentPlan}
            </Badge>
          </Link>
        )}
        <Link
          to="/dashboard/profile"
          onClick={onClick}
          className={`flex items-center gap-3 px-3 min-h-[44px] lg:min-h-0 py-2.5 lg:py-2 rounded-xl text-sm font-medium transition-colors duration-200 ${
            currentPath === "/dashboard/profile"
              ? "gradient-primary text-primary-foreground shadow-sm"
              : "text-muted-foreground hover:bg-muted/80 hover:text-foreground"
          }`}
        >
          <User className="w-4 h-4" />
          {t("sidebar.profile")}
        </Link>
        <div className="flex items-center justify-between px-3 py-1">
          <LanguageSwitcher />
          <ThemeToggle />
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-start gap-3 min-h-[44px] lg:min-h-0 text-muted-foreground hover:text-destructive"
          onClick={handleSignOut}
        >
          <LogOut className="w-4 h-4" />
          {t("nav.signOut")}
        </Button>
      </div>
    </>
  );

  return (
    <div className="min-h-screen bg-background flex">
      {/* Desktop Sidebar */}
      <aside className="hidden lg:flex flex-col w-64 border-r border-border/50 bg-card/80 backdrop-blur-sm fixed h-full z-30">
        <div className="p-5 border-b border-border/50">
          <Link to="/" className="flex items-center gap-3">
            {isWhiteLabel ? (
              <img src={getAppLogo()} alt={getAppName()} className="h-12 w-auto object-contain object-center drop-shadow-md" />
            ) : (
              <div className="w-9 h-9 rounded-xl gradient-primary flex items-center justify-center shadow-md">
                <Building2 className="w-5 h-5 text-primary-foreground" />
              </div>
            )}
            <span className="text-lg font-bold gradient-text tracking-tight">{getAppName()}</span>
          </Link>
        </div>
        <NavLinks />
      </aside>

      {/* Mobile Header */}
      <header className="lg:hidden fixed top-0 left-0 right-0 z-40 glass border-b border-border/50 pt-safe">
        <div className="flex items-center justify-between px-4 h-14">
          <Link to="/" className="flex items-center gap-3 min-h-[44px]">
            {isWhiteLabel ? (
              <img src={getAppLogo()} alt={getAppName()} className="h-10 w-auto object-contain object-center drop-shadow-sm" />
            ) : (
              <div className="w-8 h-8 rounded-lg gradient-primary flex items-center justify-center shadow-sm">
                <Building2 className="w-4 h-4 text-primary-foreground" />
              </div>
            )}
            <span className="font-bold gradient-text">{getAppName()}</span>
          </Link>
          <div className="flex items-center gap-1">
            <ThemeToggle />
            <button
              type="button"
              onClick={() => setSidebarOpen(!sidebarOpen)}
              className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center rounded-xl hover:bg-muted/50 transition-colors"
              aria-label={sidebarOpen ? "Close menu" : "Open menu"}
            >
              {sidebarOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
            </button>
          </div>
        </div>
      </header>

      {/* Mobile Sidebar Overlay */}
      {sidebarOpen && (
        <div
          className="lg:hidden fixed inset-0 z-50 bg-background/60 backdrop-blur-sm"
          onClick={() => setSidebarOpen(false)}
        >
          <aside
            className="w-72 max-w-[82vw] h-full bg-card border-r border-border/50 flex flex-col pt-safe pb-safe shadow-xl animate-in slide-in-from-left duration-200"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-4 h-14 border-b border-border/50 shrink-0">
              <span className="font-bold gradient-text">{getAppName()}</span>
              <button
                type="button"
                onClick={() => setSidebarOpen(false)}
                className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center rounded-xl hover:bg-muted/50"
                aria-label="Close navigation"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <NavLinks onClick={() => setSidebarOpen(false)} />
          </aside>
        </div>
      )}

      {/* Main Content */}
      <main className="flex-1 min-w-0 lg:ml-64 pt-[calc(3.5rem+env(safe-area-inset-top,0px))] lg:pt-0 pb-[calc(5.25rem+env(safe-area-inset-bottom,0px))] lg:pb-0">
        <div className="p-4 sm:p-6 lg:p-8 page-enter">
          {children}
        </div>
      </main>

      {/* Thumb-reachable Mobile Bottom Navigation */}
      <nav
        aria-label="Mobile bottom navigation"
        className="lg:hidden fixed bottom-0 left-0 right-0 z-40 glass border-t border-border/50 pb-safe"
      >
        <div className="grid grid-cols-5 items-center px-1 py-1">
          {mobileBottomLinks.map((item) => {
            const isActive = currentPath === item.href;
            return (
              <Link
                key={item.href}
                to={item.href}
                className={`flex flex-col items-center justify-center min-h-[48px] px-1 rounded-xl text-[11px] font-medium transition-colors ${
                  isActive ? "text-primary" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <item.icon className={`w-5 h-5 mb-0.5 ${isActive ? "text-primary" : ""}`} />
                <span className="truncate max-w-full">{item.name}</span>
              </Link>
            );
          })}
          <button
            type="button"
            onClick={() => setSidebarOpen(true)}
            className="flex flex-col items-center justify-center min-h-[48px] px-1 rounded-xl text-[11px] font-medium text-muted-foreground hover:text-foreground transition-colors"
            aria-label="More navigation"
          >
            <MoreHorizontal className="w-5 h-5 mb-0.5" />
            <span>More</span>
          </button>
        </div>
      </nav>
    </div>
  );
};

export default DashboardLayout;
