import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { lazy, Suspense } from "react";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { AppLoadingSkeleton } from "@/components/ui/AppLoadingSkeleton";
import { ThemeProvider } from "next-themes";
import { HelmetProvider } from "react-helmet-async";
import { AuthProvider } from "@/hooks/useAuth";
import { LanguageProvider } from "@/i18n/LanguageContext";
import ProtectedRoute from "@/components/ProtectedRoute";
const Index = lazy(() => import("./pages/Index"));
const Auth = lazy(() => import("./pages/Auth"));
import { isWhiteLabel } from "@/lib/branding";
const Dashboard = lazy(() => import("./pages/Dashboard"));
const Properties = lazy(() => import("./pages/Properties"));
const Rooms = lazy(() => import("./pages/Rooms"));
const Tenants = lazy(() => import("./pages/Tenants"));
const Payments = lazy(() => import("./pages/Payments"));
const Complaints = lazy(() => import("./pages/Complaints"));
const Notices = lazy(() => import("./pages/Notices"));
const Expenses = lazy(() => import("./pages/Expenses"));
const PaymentSettings = lazy(() => import("./pages/PaymentSettings"));
const Announcements = lazy(() => import("./pages/Announcements"));
const TenantInvitations = lazy(() => import("./pages/TenantInvitations"));
const TenantDashboard = lazy(() => import("./pages/TenantDashboard"));
const TenantPayments = lazy(() => import("./pages/TenantPayments"));
const TenantComplaints = lazy(() => import("./pages/TenantComplaints"));
const TenantNotices = lazy(() => import("./pages/TenantNotices"));
const TenantAnnouncements = lazy(() => import("./pages/TenantAnnouncements"));
const Marketplace = lazy(() => import("./pages/Marketplace"));
const ProfileSettings = lazy(() => import("./pages/ProfileSettings"));
import DashboardLayout from "./components/dashboard/DashboardLayout";
import TenantLayout from "./components/dashboard/TenantLayout";
const ResetPassword = lazy(() => import("./pages/ResetPassword"));
const BrowsePG = lazy(() => import("./pages/BrowsePG"));
const ListPG = lazy(() => import("./pages/ListPG"));
import NotFound from "./pages/NotFound";
const Subscription = lazy(() => import("./pages/Subscription"));
const PropertyDetail = lazy(() => import("./pages/PropertyDetail"));
const ManageListing = lazy(() => import("./pages/ManageListing"));
const TenantReviews = lazy(() => import("./pages/TenantReviews"));
const MealMenu = lazy(() => import("./pages/MealMenu"));
const TenantMealMenu = lazy(() => import("./pages/TenantMealMenu"));
const Referrals = lazy(() => import("./pages/Referrals"));
const TenantChat = lazy(() => import("./pages/TenantChat"));
const CityPGs = lazy(() => import("./pages/CityPGs"));
const TenantOnboarding = lazy(() => import("./pages/TenantOnboarding"));
const TenantDocuments = lazy(() => import("./pages/TenantDocuments"));
const Documents = lazy(() => import("./pages/Documents"));
const VisitorLog = lazy(() => import("./pages/VisitorLog"));
const UtilityBills = lazy(() => import("./pages/UtilityBills"));
const TenantUtilityBills = lazy(() => import("./pages/TenantUtilityBills"));
const TenantAnalytics = lazy(() => import("./pages/TenantAnalytics"));
const AuditLogs = lazy(() => import("./pages/AuditLogs"));
const StaffManagement = lazy(() => import("./pages/StaffManagement"));
const MoveOutManagement = lazy(() => import("./pages/MoveOutManagement"));
const TenantMoveOut = lazy(() => import("./pages/TenantMoveOut"));
const MessPlans = lazy(() => import("./pages/MessPlans"));
const MessMembers = lazy(() => import("./pages/MessMembers"));
const MessAttendance = lazy(() => import("./pages/MessAttendance"));
const MessPayments = lazy(() => import("./pages/MessPayments"));
const MessManagement = lazy(() => import("./pages/MessManagement"));
const PublicReceipt = lazy(() => import("./pages/PublicReceipt"));
const AboutUs = lazy(() => import("./pages/static/AboutUs"));
const Careers = lazy(() => import("./pages/static/Careers"));
const Blog = lazy(() => import("./pages/static/Blog"));
const Contact = lazy(() => import("./pages/static/Contact"));
const HelpCenter = lazy(() => import("./pages/static/HelpCenter"));
const FAQs = lazy(() => import("./pages/static/FAQs"));
const PrivacyPolicy = lazy(() => import("./pages/static/PrivacyPolicy"));
const TermsOfService = lazy(() => import("./pages/static/TermsOfService"));
const Pricing = lazy(() => import("./pages/static/Pricing"));
const UserGuide = lazy(() => import("./pages/static/UserGuide"));
const Features = lazy(() => import("./pages/static/Features"));


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
