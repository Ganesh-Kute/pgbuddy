import { describe, it, expect } from "vitest";
import { guardDecision, homeFor, isGoneAccountError, resolveRole, type GuardInput } from "@/lib/auth-roles";

const base: GuardInput = { loading: false, signedIn: true, role: null, isStaff: false };

describe("resolveRole", () => {
  it("returns null for no rows and no signup metadata (the account that caused the redirect loop)", () => {
    expect(resolveRole([], undefined)).toBeNull();
    expect(resolveRole(null, null)).toBeNull();
  });

  it("does not fail on two rows: owner wins (maybeSingle() used to turn this into null)", () => {
    expect(resolveRole([{ role: "tenant" }, { role: "owner" }])).toBe("owner");
    expect(resolveRole([{ role: "owner" }, { role: "tenant" }])).toBe("owner");
  });

  it("uses the single row", () => {
    expect(resolveRole([{ role: "tenant" }])).toBe("tenant");
  });

  it("falls back to the role chosen at signup, and only to a real role", () => {
    expect(resolveRole([], "owner")).toBe("owner");
    expect(resolveRole([], "tenant")).toBe("tenant");
    expect(resolveRole([], "admin")).toBeNull();
    expect(resolveRole([{ role: "tenant" }], "owner")).toBe("tenant"); // the database row beats metadata
  });
});

describe("homeFor", () => {
  it("sends owners and staff to the dashboard, tenants to /tenant, nobody else anywhere", () => {
    expect(homeFor("owner", false)).toBe("/dashboard");
    expect(homeFor(null, true)).toBe("/dashboard");
    expect(homeFor("tenant", true)).toBe("/dashboard");
    expect(homeFor("tenant", false)).toBe("/tenant");
    expect(homeFor(null, false)).toBeNull();
  });
});

describe("guardDecision", () => {
  it("waits while the role is loading instead of redirecting on a null role", () => {
    expect(guardDecision({ ...base, loading: true, requiredRole: "owner" })).toEqual({ kind: "loading" });
  });

  it("sends signed-out users to /auth", () => {
    expect(guardDecision({ ...base, signedIn: false, requiredRole: "owner" })).toEqual({ kind: "redirect", to: "/auth" });
  });

  it("lets an owner open every dashboard page (the sidebar bug)", () => {
    expect(guardDecision({ ...base, role: "owner", requiredRole: "owner" })).toEqual({ kind: "render" });
  });

  it("lets staff open dashboard pages, whatever their own role", () => {
    expect(guardDecision({ ...base, isStaff: true, requiredRole: "owner" })).toEqual({ kind: "render" });
    expect(guardDecision({ ...base, role: "tenant", isStaff: true, requiredRole: "owner" })).toEqual({ kind: "render" });
  });

  it("lets a tenant open tenant pages and sends them home from owner pages", () => {
    expect(guardDecision({ ...base, role: "tenant", requiredRole: "tenant" })).toEqual({ kind: "render" });
    expect(guardDecision({ ...base, role: "tenant", requiredRole: "owner" })).toEqual({ kind: "redirect", to: "/tenant" });
  });

  it("sends an owner who opens a tenant page to the dashboard", () => {
    expect(guardDecision({ ...base, role: "owner", requiredRole: "tenant" })).toEqual({ kind: "redirect", to: "/dashboard" });
  });

  it("shows account setup to a user with no role, on any protected page, never a redirect", () => {
    for (const requiredRole of ["owner", "tenant"] as const) {
      expect(guardDecision({ ...base, requiredRole })).toEqual({ kind: "no-role" });
    }
  });

  it("renders unrestricted protected pages for any signed-in user", () => {
    expect(guardDecision({ ...base })).toEqual({ kind: "render" });
  });
});

describe("isGoneAccountError (login for a deleted account)", () => {
  it("detects the auth server's user/session-not-found answers", () => {
    expect(isGoneAccountError({ status: 403, code: "user_not_found", message: "User from sub claim in JWT does not exist" })).toBe(true);
    expect(isGoneAccountError({ status: 403, code: "session_not_found", message: "Session not found" })).toBe(true);
    expect(isGoneAccountError({ status: 403, message: "User from sub claim in JWT does not exist" })).toBe(true);
  });

  it("detects the foreign-key failure seen on the role screen", () => {
    expect(isGoneAccountError({
      code: "23503",
      message: 'insert or update on table "user_roles" violates foreign key constraint "user_roles_user_id_fkey"',
    })).toBe(true);
  });

  it("never signs anyone out for network trouble, outages or ordinary errors", () => {
    expect(isGoneAccountError(null)).toBe(false);
    expect(isGoneAccountError(undefined)).toBe(false);
    expect(isGoneAccountError({ status: 0, message: "Failed to fetch" })).toBe(false);
    expect(isGoneAccountError({ status: 500, message: "Internal Server Error" })).toBe(false);
    expect(isGoneAccountError({ status: 401, code: "bad_jwt", message: "invalid JWT" })).toBe(false);
    expect(isGoneAccountError({ code: "42501", message: "permission denied for table user_roles" })).toBe(false);
  });
});
