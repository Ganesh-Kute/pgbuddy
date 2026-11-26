import { ReactNode, useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { signOutRemovedAccount } from "@/lib/account-removed";
import { AuthWaitScreen } from "@/components/ui/AppLoadingSkeleton";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { guardDecision, homeFor, isGoneAccountError, type AppRole } from "@/lib/auth-roles";
import { getAppName } from "@/lib/branding";

interface ProtectedRouteProps {
  children: ReactNode;
  requiredRole?: AppRole;
}

const ProtectedRoute = ({ children, requiredRole }: ProtectedRouteProps) => {
  const { user, role, isStaff, loading, accessFailed } = useAuth();
  const decision = guardDecision({ loading, signedIn: !!user, role, isStaff, requiredRole, accessFailed });

  switch (decision.kind) {
    case "loading":
      return <AuthWaitScreen />;
    case "redirect":
      return <Navigate to={decision.to} replace />;
    case "no-role":
      return <ChooseRole />;
    case "access-error":
      return <AccessError />;
    default:
      return <>{children}</>;
  }
};

/**
 * Shown to a signed-in account that has no role yet (for example a new number that used "Log in"
 * instead of "Sign up"). The role is set once, server-side, by `claim_initial_role`, which refuses
 * if the account already has one: users can no longer write `user_roles` themselves.
 */
const ChooseRole = () => {
  const { refreshRole, signOut } = useAuth();
  const navigate = useNavigate();
  const [busy, setBusy] = useState<AppRole | null>(null);
  const [error, setError] = useState<string | null>(null);

  const choose = async (picked: AppRole) => {
    setBusy(picked);
    setError(null);
    const { error: rpcError } = await supabase.rpc("claim_initial_role", { _role: picked });
    if (rpcError) {
      if (isGoneAccountError(rpcError)) {
        // The account behind this login was deleted: signing out is the only way forward.
        await signOutRemovedAccount();
        return;
      }
      const offline = typeof navigator !== "undefined" && navigator.onLine === false;
      setError(
        offline
          ? "You are offline. Connect to the internet and try again."
          : `Could not save your choice (${rpcError.code || "error"}). Try again, or sign out and sign in again.`,
      );
      setBusy(null);
      return;
    }
    await refreshRole();
    navigate(homeFor(picked, false) ?? "/", { replace: true });
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="w-full max-w-sm space-y-6 text-center">
        <div className="space-y-2">
          <h1 className="text-2xl font-bold">Finish setting up your account</h1>
          <p className="text-sm text-muted-foreground">How will you use {getAppName()}?</p>
        </div>
        <div className="grid gap-3">
          <Button size="lg" disabled={!!busy} onClick={() => choose("owner")}>
            {busy === "owner" ? "Saving..." : "I own or manage a PG"}
          </Button>
          <Button size="lg" variant="outline" disabled={!!busy} onClick={() => choose("tenant")}>
            {busy === "tenant" ? "Saving..." : "I live in a PG"}
          </Button>
        </div>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <p className="text-xs text-muted-foreground">
          Staff member? Ask your PG owner to invite this phone number, then sign in again.
        </p>
        <Button variant="ghost" size="sm" onClick={() => signOut()}>
          Sign out
        </Button>
      </div>
    </div>
  );
};

/** The role could not be read (connection or browser trouble): retry, never guess. */
const AccessError = () => {
  const { refreshRole, signOut } = useAuth();
  const [busy, setBusy] = useState(false);
  const retry = async () => {
    setBusy(true);
    await refreshRole();
    setBusy(false);
  };
  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="w-full max-w-sm space-y-6 text-center">
        <div className="space-y-2">
          <h1 className="text-2xl font-bold">Could not load your account</h1>
          <p className="text-sm text-muted-foreground">Check your internet connection and try again.</p>
        </div>
        <Button size="lg" className="w-full" disabled={busy} onClick={retry}>
          {busy ? "Trying..." : "Try again"}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => signOut()}>
          Sign out
        </Button>
      </div>
    </div>
  );
};

export default ProtectedRoute;
