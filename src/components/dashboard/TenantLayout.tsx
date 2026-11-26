import { useState } from "react";
import { Link, useNavigate, useLocation } from "react-router-dom";
import {
  Building2, CreditCard, MessageSquare,
  LogOut, Menu, X, LayoutDashboard, Megaphone, User, UtensilsCrossed, MessageCircle,
  ClipboardCheck, Zap, DoorOpen, MoreHorizontal,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/useAuth";
import NotificationBell from "@/components/NotificationBell";
import { useLanguage } from "@/i18n/LanguageContext";
import LanguageSwitcher from "@/components/LanguageSwitcher";
import ThemeToggle from "@/components/ThemeToggle";
import { getAppName, getAppLogo, isWhiteLabel } from "@/lib/branding";

const getSidebarLinks = (t: (k: string) => string) => [
  { name: t("tenant.myRoom"), href: "/tenant", icon: LayoutDashboard },
  { name: t("tenant.payments"), href: "/tenant/payments", icon: CreditCard },
  { name: t("tenant.complaints"), href: "/tenant/complaints", icon: MessageSquare },
  { name: t("tenant.announcements"), href: "/tenant/announcements", icon: Megaphone },
  { name: t("tenant.mealMenu"), href: "/tenant/meal-menu", icon: UtensilsCrossed },
  { name: "Community Chat", href: "/tenant/chat", icon: MessageCircle },
  { name: "Onboarding", href: "/tenant/onboarding", icon: ClipboardCheck },
  { name: "Utility Bills", href: "/tenant/utility-bills", icon: Zap },
  { name: "Move-Out", href: "/tenant/move-out", icon: DoorOpen },
];

const getBottomLinks = (t: (k: string) => string) => [
  { name: t("sidebar.profile"), href: "/tenant/profile", icon: User },
];

const TenantLayout = ({ children }: { children: React.ReactNode }) => {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const { signOut } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const { t } = useLanguage();
  const sidebarLinks = getSidebarLinks(t);
  const bottomLinks = getBottomLinks(t);
  const currentPath = location.pathname;

  const mobileBottomLinks = [
    { name: t("tenant.myRoom"), href: "/tenant", icon: LayoutDashboard },
    { name: t("tenant.payments"), href: "/tenant/payments", icon: CreditCard },
    { name: t("tenant.complaints"), href: "/tenant/complaints", icon: MessageSquare },
    { name: t("tenant.mealMenu"), href: "/tenant/meal-menu", icon: UtensilsCrossed },
  ];

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
        {bottomLinks.map((link) => {
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
              <link.icon className="w-4 h-4" />
              {link.name}
            </Link>
          );
        })}
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
        <div className="p-5 border-b border-border/50 flex items-center justify-between">
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
          <NotificationBell />
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
            <NotificationBell />
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

export default TenantLayout;
