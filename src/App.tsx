import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Suspense } from "react";
import { lazyWithReload } from "@/lib/staleBuild";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { AppLoadingSkeleton } from "@/components/ui/AppLoadingSkeleton";
import { ThemeProvider } from "next-themes";
import { HelmetProvider } from "react-helmet-async";
import { AuthProvider } from "@/hooks/useAuth";
import { LanguageProvider } from "@/i18n/LanguageContext";
import ProtectedRoute from "@/components/ProtectedRoute";
const Index = lazyWithReload(() => import("./pages/Index"));
const Auth = lazyWithReload(() => import("./pages/Auth"));
import { isWhiteLabel } from "@/lib/branding";
const Dashboard = lazyWithReload(() => import("./pages/Dashboard"));
const Properties = lazyWithReload(() => import("./pages/Properties"));
const Rooms = lazyWithReload(() => import("./pages/Rooms"));
const Tenants = lazyWithReload(() => import("./pages/Tenants"));
const Payments = lazyWithReload(() => import("./pages/Payments"));
const Complaints = lazyWithReload(() => import("./pages/Complaints"));
const Notices = lazyWithReload(() => import("./pages/Notices"));
const Expenses = lazyWithReload(() => import("./pages/Expenses"));
const PaymentSettings = lazyWithReload(() => import("./pages/PaymentSettings"));
const Announcements = lazyWithReload(() => import("./pages/Announcements"));
const TenantInvitations = lazyWithReload(() => import("./pages/TenantInvitations"));
const TenantDashboard = lazyWithReload(() => import("./pages/TenantDashboard"));
const TenantPayments = lazyWithReload(() => import("./pages/TenantPayments"));
const TenantComplaints = lazyWithReload(() => import("./pages/TenantComplaints"));
const TenantNotices = lazyWithReload(() => import("./pages/TenantNotices"));
const TenantAnnouncements = lazyWithReload(() => import("./pages/TenantAnnouncements"));
const Marketplace = lazyWithReload(() => import("./pages/Marketplace"));
const ProfileSettings = lazyWithReload(() => import("./pages/ProfileSettings"));
import DashboardLayout from "./components/dashboard/DashboardLayout";
import TenantLayout from "./components/dashboard/TenantLayout";
const ResetPassword = lazyWithReload(() => import("./pages/ResetPassword"));
const BrowsePG = lazyWithReload(() => import("./pages/BrowsePG"));
const ListPG = lazyWithReload(() => import("./pages/ListPG"));
import NotFound from "./pages/NotFound";
const Subscription = lazyWithReload(() => import("./pages/Subscription"));
const PropertyDetail = lazyWithReload(() => import("./pages/PropertyDetail"));
const ManageListing = lazyWithReload(() => import("./pages/ManageListing"));
const TenantReviews = lazyWithReload(() => import("./pages/TenantReviews"));
const MealMenu = lazyWithReload(() => import("./pages/MealMenu"));
const TenantMealMenu = lazyWithReload(() => import("./pages/TenantMealMenu"));
const Referrals = lazyWithReload(() => import("./pages/Referrals"));
const TenantChat = lazyWithReload(() => import("./pages/TenantChat"));
const CityPGs = lazyWithReload(() => import("./pages/CityPGs"));
const TenantOnboarding = lazyWithReload(() => import("./pages/TenantOnboarding"));
const TenantDocuments = lazyWithReload(() => import("./pages/TenantDocuments"));
const Documents = lazyWithReload(() => import("./pages/Documents"));
const VisitorLog = lazyWithReload(() => import("./pages/VisitorLog"));
const UtilityBills = lazyWithReload(() => import("./pages/UtilityBills"));
const TenantUtilityBills = lazyWithReload(() => import("./pages/TenantUtilityBills"));
const TenantAnalytics = lazyWithReload(() => import("./pages/TenantAnalytics"));
const AuditLogs = lazyWithReload(() => import("./pages/AuditLogs"));
const StaffManagement = lazyWithReload(() => import("./pages/StaffManagement"));
const MoveOutManagement = lazyWithReload(() => import("./pages/MoveOutManagement"));
const TenantMoveOut = lazyWithReload(() => import("./pages/TenantMoveOut"));
const MessPlans = lazyWithReload(() => import("./pages/MessPlans"));
const MessMembers = lazyWithReload(() => import("./pages/MessMembers"));
const MessAttendance = lazyWithReload(() => import("./pages/MessAttendance"));
const MessPayments = lazyWithReload(() => import("./pages/MessPayments"));
const MessManagement = lazyWithReload(() => import("./pages/MessManagement"));
const PublicReceipt = lazyWithReload(() => import("./pages/PublicReceipt"));
const AboutUs = lazyWithReload(() => import("./pages/static/AboutUs"));
const MauliPG = lazyWithReload(() => import("./pages/static/MauliPG"));
const Careers = lazyWithReload(() => import("./pages/static/Careers"));
const Blog = lazyWithReload(() => import("./pages/static/Blog"));
const Contact = lazyWithReload(() => import("./pages/static/Contact"));
const HelpCenter = lazyWithReload(() => import("./pages/static/HelpCenter"));
const FAQs = lazyWithReload(() => import("./pages/static/FAQs"));
const PrivacyPolicy = lazyWithReload(() => import("./pages/static/PrivacyPolicy"));
const TermsOfService = lazyWithReload(() => import("./pages/static/TermsOfService"));
const Pricing = lazyWithReload(() => import("./pages/static/Pricing"));
const UserGuide = lazyWithReload(() => import("./pages/static/UserGuide"));
const Features = lazyWithReload(() => import("./pages/static/Features"));


// Pages load on demand: the app used to ship every page in one 2 MB script before the first paint.
// Cached reads stay fresh for a minute, so moving between pages does not refetch everything.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 60_000, gcTime: 5 * 60_000, refetchOnWindowFocus: false, retry: 1 },
  },
});

const App = () => (
  <HelmetProvider>
  <ThemeProvider attribute="class" defaultTheme="light" enableSystem>
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <LanguageProvider>
          <TooltipProvider>
          <Toaster />
          <Sonner />
          <BrowserRouter>
            <Suspense fallback={<AppLoadingSkeleton />}>
            <Routes>
              <Route path="/" element={isWhiteLabel ? <Auth /> : <Index />} />
              <Route path="/auth" element={<Auth />} />
              <Route path="/reset-password" element={<ResetPassword />} />
              <Route path="/browse" element={<BrowsePG />} />
              <Route path="/list-pg" element={<ListPG />} />
              <Route path="/pg/:id" element={<PropertyDetail />} />
              {/* Owner routes */}
              <Route path="/dashboard" element={<ProtectedRoute requiredRole="owner"><Dashboard /></ProtectedRoute>} />
              <Route path="/dashboard/properties" element={<ProtectedRoute requiredRole="owner"><Properties /></ProtectedRoute>} />
              <Route path="/dashboard/rooms" element={<ProtectedRoute requiredRole="owner"><Rooms /></ProtectedRoute>} />
              <Route path="/dashboard/tenants" element={<ProtectedRoute requiredRole="owner"><Tenants /></ProtectedRoute>} />
              <Route path="/dashboard/payments" element={<ProtectedRoute requiredRole="owner"><Payments /></ProtectedRoute>} />
              <Route path="/dashboard/complaints" element={<ProtectedRoute requiredRole="owner"><Complaints /></ProtectedRoute>} />
              <Route path="/dashboard/notices" element={<ProtectedRoute requiredRole="owner"><Notices /></ProtectedRoute>} />
              <Route path="/dashboard/expenses" element={<ProtectedRoute requiredRole="owner"><Expenses /></ProtectedRoute>} />
              <Route path="/dashboard/payment-settings" element={<ProtectedRoute requiredRole="owner"><PaymentSettings /></ProtectedRoute>} />
              <Route path="/dashboard/announcements" element={<ProtectedRoute requiredRole="owner"><Announcements /></ProtectedRoute>} />
              <Route path="/dashboard/invitations" element={<ProtectedRoute requiredRole="owner"><TenantInvitations /></ProtectedRoute>} />
              <Route path="/dashboard/profile" element={<ProtectedRoute requiredRole="owner"><ProfileSettings Layout={DashboardLayout} /></ProtectedRoute>} />
              <Route path="/dashboard/subscription" element={<ProtectedRoute requiredRole="owner"><Subscription /></ProtectedRoute>} />
              <Route path="/dashboard/listing" element={<ProtectedRoute requiredRole="owner"><ManageListing /></ProtectedRoute>} />
              <Route path="/dashboard/meal-menu" element={<ProtectedRoute requiredRole="owner"><MealMenu /></ProtectedRoute>} />
              <Route path="/dashboard/referrals" element={<ProtectedRoute requiredRole="owner"><Referrals /></ProtectedRoute>} />
              <Route path="/dashboard/documents" element={<ProtectedRoute requiredRole="owner"><Documents /></ProtectedRoute>} />
              <Route path="/dashboard/visitors" element={<ProtectedRoute requiredRole="owner"><VisitorLog /></ProtectedRoute>} />
              <Route path="/dashboard/utility-bills" element={<ProtectedRoute requiredRole="owner"><UtilityBills /></ProtectedRoute>} />
              <Route path="/dashboard/analytics" element={<ProtectedRoute requiredRole="owner"><TenantAnalytics /></ProtectedRoute>} />
              <Route path="/dashboard/audit-logs" element={<ProtectedRoute requiredRole="owner"><AuditLogs /></ProtectedRoute>} />
              <Route path="/dashboard/staff" element={<ProtectedRoute requiredRole="owner"><StaffManagement /></ProtectedRoute>} />
              <Route path="/dashboard/move-out" element={<ProtectedRoute requiredRole="owner"><MoveOutManagement /></ProtectedRoute>} />
              {/* Mess routes */}
              <Route path="/dashboard/mess" element={<ProtectedRoute requiredRole="owner"><MessManagement /></ProtectedRoute>} />
              {/* Tenant routes */}
              <Route path="/tenant" element={<ProtectedRoute requiredRole="tenant"><TenantDashboard /></ProtectedRoute>} />
              <Route path="/tenant/payments" element={<ProtectedRoute requiredRole="tenant"><TenantPayments /></ProtectedRoute>} />
              <Route path="/tenant/complaints" element={<ProtectedRoute requiredRole="tenant"><TenantComplaints /></ProtectedRoute>} />
              <Route path="/tenant/notices" element={<ProtectedRoute requiredRole="tenant"><TenantNotices /></ProtectedRoute>} />
              <Route path="/tenant/announcements" element={<ProtectedRoute requiredRole="tenant"><TenantAnnouncements /></ProtectedRoute>} />
              <Route path="/tenant/marketplace" element={<ProtectedRoute requiredRole="tenant"><Marketplace /></ProtectedRoute>} />
              <Route path="/tenant/profile" element={<ProtectedRoute requiredRole="tenant"><ProfileSettings Layout={TenantLayout} /></ProtectedRoute>} />
              <Route path="/tenant/reviews" element={<ProtectedRoute requiredRole="tenant"><TenantReviews /></ProtectedRoute>} />
              <Route path="/tenant/meal-menu" element={<ProtectedRoute requiredRole="tenant"><TenantMealMenu /></ProtectedRoute>} />
              <Route path="/tenant/chat" element={<ProtectedRoute requiredRole="tenant"><TenantChat /></ProtectedRoute>} />
              <Route path="/tenant/onboarding" element={<ProtectedRoute requiredRole="tenant"><TenantOnboarding /></ProtectedRoute>} />
              <Route path="/tenant/documents" element={<ProtectedRoute requiredRole="tenant"><TenantDocuments /></ProtectedRoute>} />
              <Route path="/tenant/utility-bills" element={<ProtectedRoute requiredRole="tenant"><TenantUtilityBills /></ProtectedRoute>} />
              <Route path="/tenant/move-out" element={<ProtectedRoute requiredRole="tenant"><TenantMoveOut /></ProtectedRoute>} />
              {/* SEO city pages */}
              <Route path="/pgs/:city" element={<CityPGs />} />
              {/* Static pages */}
              <Route path="/about" element={<AboutUs />} />
              <Route path="/mauli-pg" element={<MauliPG />} />
              <Route path="/careers" element={<Careers />} />
              <Route path="/blog" element={<Blog />} />
              <Route path="/contact" element={<Contact />} />
              <Route path="/help" element={<HelpCenter />} />
              <Route path="/faqs" element={<FAQs />} />
              <Route path="/privacy" element={<PrivacyPolicy />} />
              <Route path="/terms" element={<TermsOfService />} />
              <Route path="/pricing" element={<Pricing />} />
              <Route path="/guide" element={<UserGuide />} />
              <Route path="/features" element={<Features />} />
              <Route path="/receipt/:id" element={<PublicReceipt />} />
              {/* ADD ALL CUSTOM ROUTES ABOVE THE CATCH-ALL "*" ROUTE */}
              <Route path="*" element={<NotFound />} />
            </Routes>
            </Suspense>
          </BrowserRouter>
        </TooltipProvider>
      </LanguageProvider>
    </AuthProvider>
  </QueryClientProvider>
  </ThemeProvider>
  </HelmetProvider>
);

export default App;
