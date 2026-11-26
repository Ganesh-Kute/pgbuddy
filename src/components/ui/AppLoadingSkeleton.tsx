import { useEffect, useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/useAuth";

/** After this long on the loading screen, offer a way out (bad network must never lock anyone out). */
export const SLOW_LOGIN_MS = 8000;

// The ONE full-screen loader: lazy pages (Suspense), the route guard and the sign-in page while a
// saved login is read all show this same screen, so nothing flashes or swaps on the way in.
export const AppLoadingSkeleton = () => {
  return (
    <div className="min-h-screen bg-background flex" role="status" aria-busy="true" aria-label="Loading">
      {/* Desktop Sidebar Skeleton - hidden on mobile */}
      <aside className="hidden lg:flex flex-col w-64 border-r border-border/50 bg-card/80 p-5 space-y-4">
        <div className="flex items-center gap-3 mb-6">
          <Skeleton className="w-9 h-9 rounded-xl" />
          <Skeleton className="h-6 w-24" />
        </div>
        
        {/* Navigation links skeletons */}
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-10 w-full rounded-xl" />
        ))}
      </aside>

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col">
        {/* Mobile Header Skeleton - visible only on mobile */}
        <div className="lg:hidden fixed top-0 left-0 right-0 pt-safe border-b border-border/50 bg-background/80 z-40">
          <div className="h-14 flex items-center justify-between px-4">
            <div className="flex items-center gap-2">
              <Skeleton className="w-8 h-8 rounded-lg" />
              <Skeleton className="w-20 h-5" />
            </div>
            <Skeleton className="w-11 h-11 rounded-lg" />
          </div>
        </div>

        {/* Content Area */}
        <main className="flex-1 p-4 sm:p-6 lg:ml-64 lg:p-8 pt-20 lg:pt-8 w-full">
          {/* Header section skeleton */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-8">
            <div className="space-y-2">
              <Skeleton className="h-8 w-48" />
              <Skeleton className="h-4 w-64" />
            </div>
            <Skeleton className="h-10 w-32 rounded-lg" />
          </div>

          {/* KPI Cards Grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={`kpi-${i}`} className="p-6 rounded-xl border border-border/50 bg-card/50">
                <Skeleton className="h-5 w-24 mb-4" />
                <Skeleton className="h-8 w-16 mb-2" />
                <Skeleton className="h-4 w-32" />
              </div>
            ))}
          </div>

          {/* Large Content Block */}
          <div className="border border-border/50 bg-card/50 rounded-xl p-6 h-96">
            <div className="flex justify-between mb-6">
              <Skeleton className="h-6 w-32" />
              <Skeleton className="h-8 w-24" />
            </div>
            <div className="space-y-4">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={`row-${i}`} className="h-12 w-full rounded-lg" />
              ))}
            </div>
          </div>
        </main>
      </div>
    </div>
  );
};

/**
 * The loading screen while the saved login and its role are read. If that takes longer than
 * SLOW_LOGIN_MS (slow or broken network), it adds "Retry" and "Sign in again" on top.
 */
export const AuthWaitScreen = () => {
  const { user, refreshRole, recheckSession, signOut } = useAuth();
  const [slow, setSlow] = useState(false);
  // Separate flags: a Retry that hangs on a dead network must never disable the way out.
  const [retrying, setRetrying] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setSlow(true), SLOW_LOGIN_MS);
    return () => clearTimeout(t);
  }, []);

  const retry = async () => {
    setRetrying(true);
    try {
      // Signed in: read the role again. Not known yet whether a login is saved: read the session again.
      if (user) await refreshRole();
      else await recheckSession();
    } finally {
      setRetrying(false);
    }
  };

  const signInAgain = async () => {
    setSigningOut(true);
    try {
      // Local sign-out: it needs no network, so a dead connection cannot keep the old login around.
      await signOut({ local: true });
    } finally {
      setSigningOut(false);
    }
  };

  return (
    <>
      <AppLoadingSkeleton />
      {slow && (
        <div className="fixed inset-x-0 bottom-0 z-50 p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
          <div className="mx-auto max-w-sm rounded-2xl border border-border bg-card p-5 text-center shadow-xl" role="alert">
            <p className="font-semibold">Taking longer than usual</p>
            <p className="mt-1 text-sm text-muted-foreground">Check your internet connection.</p>
            <div className="mt-4 grid grid-cols-2 gap-3">
              <Button variant="outline" className="min-h-11" disabled={signingOut} onClick={signInAgain}>
                Sign in again
              </Button>
              <Button className="min-h-11" disabled={retrying || signingOut} onClick={retry}>
                {retrying ? "Trying..." : "Retry"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};
