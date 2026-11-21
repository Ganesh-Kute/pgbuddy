import { createContext, useCallback, useContext, useEffect, useRef, useState, ReactNode } from "react";
import { User, Session } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import { resolveRole, type UserRole } from "@/lib/auth-roles";

export type { UserRole } from "@/lib/auth-roles";

interface AuthContextType {
  user: User | null;
  session: Session | null;
  role: UserRole;
  /** An active staff member of some owner: works in that owner's /dashboard. */
  isStaff: boolean;
  /** True until both the session and, for a signed-in user, their role are known. */
  loading: boolean;
  signOut: () => Promise<void>;
  /** Re-read the role, e.g. after the user picks one on the account-setup screen. */
  refreshRole: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  session: null,
  role: null,
  isStaff: false,
  loading: true,
  signOut: async () => {},
  refreshRole: async () => {},
});

export const useAuth = () => useContext(AuthContext);

type Access = { userId: string; role: UserRole; isStaff: boolean };

async function loadAccess(user: User): Promise<Access> {
  // Link a pending staff invitation for this account first, so the staff lookup below sees it.
  const { error: claimError } = await supabase.rpc("claim_staff_invitation");
  if (claimError) console.error("claim_staff_invitation failed:", claimError.message);

  const [roles, staff] = await Promise.all([
    // Every row, not .maybeSingle(): a user with two roles used to come back as an error, then as no role.
    supabase.from("user_roles").select("role").eq("user_id", user.id),
    supabase
      .from("staff_members")
      .select("id")
      .eq("staff_user_id", user.id)
      .eq("status", "active")
      .limit(1),
  ]);
  if (roles.error) console.error("Could not read user_roles:", roles.error.message);
  if (staff.error) console.error("Could not read staff_members:", staff.error.message);

  return {
    userId: user.id,
    role: resolveRole(roles.data, user.user_metadata?.role),
    isStaff: (staff.data?.length ?? 0) > 0,
  };
}

export const AuthProvider = ({ children }: { children: ReactNode }) => {
  const [session, setSession] = useState<Session | null>(null);
  const [sessionKnown, setSessionKnown] = useState(false);
  const [access, setAccess] = useState<Access | null>(null);
  const request = useRef(0);

  const user = session?.user ?? null;
  const userId = user?.id ?? null;

  useEffect(() => {
    // onAuthStateChange delivers INITIAL_SESSION first, so no separate getSession() call is needed:
    // the two used to race, each fetching the role and each turning `loading` off on its own.
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, next) => {
      setSession(next);
      setSessionKnown(true);
      if (event === "PASSWORD_RECOVERY") window.location.href = "/reset-password";
    });
    return () => subscription.unsubscribe();
  }, []);

  const fetchAccess = useCallback(async (forUser: User) => {
    const ticket = ++request.current;
    try {
      const next = await loadAccess(forUser);
      if (ticket === request.current) setAccess(next);
    } catch (err) {
      console.error("Unexpected error loading access:", err);
      if (ticket === request.current) setAccess({ userId: forUser.id, role: null, isStaff: false });
    }
  }, []);

  // Fetch once per signed-in user. A token refresh keeps the same user id, so it no longer refetches.
  useEffect(() => {
    if (!user) {
      request.current++;
      setAccess(null);
      return;
    }
    // Deferred out of the auth callback's tick: Supabase warns that awaiting inside it can deadlock.
    const t = setTimeout(() => fetchAccess(user), 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refetch for a new user, not a new token
  }, [userId, fetchAccess]);

  const refreshRole = useCallback(async () => {
    if (user) await fetchAccess(user);
  }, [user, fetchAccess]);

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
    setSession(null);
    setAccess(null);
  }, []);

  // Until the role for THIS user has arrived, report loading. A just-signed-in user used to be seen
  // with role = null for a moment, and the guard redirected them before the role came back.
  const accessReady = !user || access?.userId === user.id;
  const value: AuthContextType = {
    user,
    session,
    role: accessReady && access ? access.role : null,
    isStaff: accessReady && access ? access.isStaff : false,
    loading: !sessionKnown || !accessReady,
    signOut,
    refreshRole,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};
