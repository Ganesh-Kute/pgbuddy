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
};

export type GuardDecision =
  | { kind: "loading" }
  | { kind: "render" }
  | { kind: "redirect"; to: string }
  | { kind: "no-role" };

export function guardDecision({ loading, signedIn, role, isStaff, requiredRole }: GuardInput): GuardDecision {
  if (loading) return { kind: "loading" };
  if (!signedIn) return { kind: "redirect", to: "/auth" };
  if (!requiredRole) return { kind: "render" };
  if (requiredRole === "owner" && (role === "owner" || isStaff)) return { kind: "render" };
  if (requiredRole === "tenant" && role === "tenant") return { kind: "render" };
  const home = homeFor(role, isStaff);
  // No role at all: say so, rather than bouncing between /dashboard and /tenant.
  if (!home) return { kind: "no-role" };
  return { kind: "redirect", to: home };
}
