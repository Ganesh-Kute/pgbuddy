// Role resolution and route-guard decisions, kept free of React and Supabase so they can be tested.
//
// Why this exists: `user_roles` was read with `.maybeSingle()`, so a user with no row OR with two rows
// (owner + tenant) got `role = null`, and the guard then bounced every sidebar click to `/tenant`.
// Staff members never had a role at all, so they could not open any `/dashboard/*` page.

export type AppRole = "owner" | "tenant";
export type UserRole = AppRole | null;

/** Pick one role from every row the user has. Owner wins: an owner who is also a tenant somewhere manages first. */
export function resolveRole(rows: ReadonlyArray<{ role: string | null }> | null | undefined, metadataRole?: unknown): UserRole {
  const roles = new Set((rows ?? []).map((r) => r.role));
  if (roles.has("owner")) return "owner";
  if (roles.has("tenant")) return "tenant";
  // No row yet: the role chosen at signup travels in the auth metadata. It is only a hint for routing;
  // the database grants nothing on it, and RLS still decides what the user can read.
  if (metadataRole === "owner" || metadataRole === "tenant") return metadataRole;
  return null;
}

/** Where a signed-in user belongs. Staff work in the owner dashboard of the owner who invited them. */
export function homeFor(role: UserRole, isStaff: boolean): string | null {
  if (role === "owner" || isStaff) return "/dashboard";
  if (role === "tenant") return "/tenant";
  return null;
}

export type GuardInput = {
  loading: boolean;
  signedIn: boolean;
  role: UserRole;
  isStaff: boolean;
  requiredRole?: AppRole;
  /**
   * The role could not be read (network error, browser lock timeout, server error). Then role = null
   * means "unknown", not "none": the account-setup screen must not be shown.
   */
  accessFailed?: boolean;
};

export type GuardDecision =
  | { kind: "loading" }
  | { kind: "render" }
  | { kind: "redirect"; to: string }
  | { kind: "no-role" }
  | { kind: "access-error" };

export function guardDecision({ loading, signedIn, role, isStaff, requiredRole, accessFailed }: GuardInput): GuardDecision {
  if (loading) return { kind: "loading" };
  if (!signedIn) return { kind: "redirect", to: "/auth" };
  if (!requiredRole) return { kind: "render" };
  if (requiredRole === "owner" && (role === "owner" || isStaff)) return { kind: "render" };
  if (requiredRole === "tenant" && role === "tenant") return { kind: "render" };
  const home = homeFor(role, isStaff);
  // The role could not be read: offer a retry. A tenant on a phone browser was shown "Finish setting
  // up your account" because a failed read was taken for "no role" (2026-11-25).
  // No role at all: say so, rather than bouncing between /dashboard and /tenant.
  if (!home) return accessFailed ? { kind: "access-error" } : { kind: "no-role" };
  return { kind: "redirect", to: home };
}

// ---------------------------------------------------------------------------------------------------
// Logins whose account no longer exists.
//
// A phone keeps its session token after the account is deleted (or its session revoked) in Supabase.
// The token still decodes, so the app looked signed in, but every write failed: picking a role hit
// the user_roles -> auth.users foreign key and showed "Could not save your choice". Seen in the APK on
// 2026-11-22 after a test number registered as tenant and staff was deleted from the database.

export type AuthLikeError = {
  status?: number | null;
  code?: string | null;
  message?: string | null;
} | null | undefined;

const GONE_AUTH_CODES = new Set(["user_not_found", "session_not_found", "refresh_token_not_found", "user_banned"]);

/**
 * True when the server says this login's account or session is gone, so the only way forward is to
 * sign in again. False for network errors and outages: those must not sign anyone out.
 */
export function isGoneAccountError(err: AuthLikeError): boolean {
  if (!err) return false;
  const code = (err.code ?? "").toLowerCase();
  const message = (err.message ?? "").toLowerCase();
  if (GONE_AUTH_CODES.has(code)) return true;
  // Older auth servers send no code, only this message (HTTP 403).
  if (message.includes("user from sub claim in jwt does not exist")) return true;
  if (message.includes("session from session_id claim in jwt does not exist")) return true;
  // Postgres foreign-key violation from a write keyed on auth.uid(): the auth user row is gone.
  if (code === "23503" && message.includes("user")) return true;
  return false;
}

/** Shown once on the sign-in screen after the app signed a removed account out. */
export const ACCOUNT_REMOVED_FLAG = "pgbuddy.accountRemoved";
