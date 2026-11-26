import { createContext, useCallback, useContext, useEffect, useRef, useState, ReactNode } from "react";
import { User, Session } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import { isGoneAccountError, resolveRole, type UserRole } from "@/lib/auth-roles";
import { AccountGoneError, signOutRemovedAccount } from "@/lib/account-removed";
import { forgetSavedLogin, restartAt } from "@/lib/savedLogin";

export type { UserRole } from "@/lib/auth-roles";

interface AuthContextType {
  user: User | null;
  session: Session | null;
  role: UserRole;
  /** An active staff member of some owner: works in that owner's /dashboard. */
  isStaff: boolean;
  /** The role could not be read (see loadAccess); role = null then means unknown, not none. */
  accessFailed: boolean;
  /** True until both the session and, for a signed-in user, their role are known. */
  loading: boolean;
  /** `local`: end the login on this device only (works with no network). */
  signOut: (options?: { local?: boolean }) => Promise<void>;
  /** Re-read the role, e.g. after the user picks one on the account-setup screen. */
  refreshRole: () => Promise<void>;
  /** Read the saved login again (the loading screen's Retry while it is not known yet). */
  recheckSession: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  session: null,
  role: null,
  isStaff: false,
  accessFailed: false,
  loading: true,
  signOut: async () => {},
  refreshRole: async () => {},
  recheckSession: async () => {},
});

export const useAuth = () => useContext(AuthContext);

type Access = { userId: string; role: UserRole; isStaff: boolean; failed: boolean };

/** How long "Sign in again" waits for Supabase's own sign-out before clearing the login itself. */
export const LOCAL_SIGN_OUT_WAIT_MS = 3000;

/** Waits before each retry of the role read: a dropped connection or a busy login lock usually clears. */
const RETRY_DELAYS_MS = [400, 1200, 2500];


async function loadAccess(user: User): Promise<Access> {
  // Link a pending staff invitation for this account, so the staff lookup sees it. Only that lookup
  // waits for it: the sign-in check and the role read start at once (it used to cost every app open
  // one extra round trip before anything, measured by agent-1 on 26 Nov).
  // A claim that could not reach the server fails the staff read, so it is retried and then reported
  // as failed: a new staff member was otherwise sent to "choose your role" (Antigravity's review).
  // A database error is logged and ignored as before, so a broken function cannot lock anyone out.
  const claim = async (): Promise<{ message: string } | null> => {
    try {
      const { error } = await supabase.rpc("claim_staff_invitation");
      if (!error) return null;
      console.error("claim_staff_invitation failed:", error.message);
      return error.code ? null : error; // PostgREST gives network failures no code
    } catch (err) {
      console.error("claim_staff_invitation failed:", err);
      return { message: String(err) };
    }
  };
  const readStaff = async () => {
    const claimError = await claim();
    if (claimError) return { data: null, error: claimError };
    return supabase.from("staff_members").select("id").eq("staff_user_id", user.id).eq("status", "active").limit(1);
  };

  const read = () =>
    Promise.all([
      // The saved token is only decoded locally, so a deleted account still looks signed in.
      // getUser() asks the auth server. It runs alongside the reads below, so startup is not slower.
      supabase.auth.getUser(),
      // Every row, not .maybeSingle(): a user with two roles used to come back as an error, then as no role.
      supabase.from("user_roles").select("role").eq("user_id", user.id),
      readStaff(),
    ]);

  // A failed read is retried, and if it keeps failing it is reported as failed, never as "no role":
  // a tenant on a phone browser was shown "Finish setting up your account" because the role read
  // failed inside the browser (it never reached the server) and the failure looked like no role.
  let [check, roles, staff] = await read();
  for (const delay of RETRY_DELAYS_MS) {
    if (isGoneAccountError(check.error)) break;
    if (!roles.error && !staff.error) break;
    await new Promise((r) => setTimeout(r, delay));
    [check, roles, staff] = await read();
  }
  if (isGoneAccountError(check.error)) throw new AccountGoneError(check.error?.message);
  if (roles.error) console.error("Could not read user_roles:", roles.error.message);
  if (staff.error) console.error("Could not read staff_members:", staff.error.message);

  return {
    userId: user.id,
    role: resolveRole(roles.data, user.user_metadata?.role),
    isStaff: (staff.data?.length ?? 0) > 0,
    failed: !!(roles.error || staff.error),
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
      if (err instanceof AccountGoneError) {
        console.warn("Saved login belongs to a removed account; signing out.", err.message);
        if (ticket === request.current) await signOutRemovedAccount();
        return;
      }
      console.error("Unexpected error loading access:", err);
      if (ticket === request.current) setAccess({ userId: forUser.id, role: null, isStaff: false, failed: true });
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

  const recheckSession = useCallback(async () => {
    const { data } = await supabase.auth.getSession();
    setSession(data.session);
    setSessionKnown(true);
  }, []);

  // A normal sign-out also ends the login on the server. With no network that call fails and Supabase
  // then KEEPS the login on the device, so fall back to a local sign-out; `local` skips the server.
  const signOut = useCallback(async (options?: { local?: boolean }) => {
    if (options?.local) {
      // Supabase's sign-out can wait forever for a lock held by a request on a dead network.
      const finished = await Promise.race([
        supabase.auth.signOut({ scope: "local" }).then(
          ({ error }) => !error,
          () => false,
        ),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), LOCAL_SIGN_OUT_WAIT_MS)),
      ]);
      if (!finished) {
        forgetSavedLogin();
        restartAt("/auth");
        return;
      }
      request.current++;
      setSession(null);
      setAccess(null);
      return;
    }
    try {
      const { error } = await supabase.auth.signOut();
      if (error) await supabase.auth.signOut({ scope: "local" });
    } catch (err) {
      console.error("Sign-out failed; clearing the login on this device:", err);
      await supabase.auth.signOut({ scope: "local" }).catch(() => {});
    } finally {
      request.current++;
      setSession(null);
      setAccess(null);
    }
  }, []);

  // Until the role for THIS user has arrived, report loading. A just-signed-in user used to be seen
  // with role = null for a moment, and the guard redirected them before the role came back.
  const accessReady = !user || access?.userId === user.id;
  const value: AuthContextType = {
    user,
    session,
    role: accessReady && access ? access.role : null,
    isStaff: accessReady && access ? access.isStaff : false,
    accessFailed: accessReady && access ? access.failed : false,
    loading: !sessionKnown || !accessReady,
    signOut,
    refreshRole,
    recheckSession,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};
