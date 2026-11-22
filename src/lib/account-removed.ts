import { supabase } from "@/integrations/supabase/client";
import { ACCOUNT_REMOVED_FLAG } from "@/lib/auth-roles";

/** The saved login belongs to an account (or session) the server no longer has. */
export class AccountGoneError extends Error {}

/** Sign a removed account out on this device only, and tell the sign-in screen why. */
export async function signOutRemovedAccount(): Promise<void> {
  try {
    sessionStorage.setItem(ACCOUNT_REMOVED_FLAG, "1");
  } catch {
    // Storage can be unavailable; the sign-out below still happens.
  }
  // "local": the server already dropped this session, so a global sign-out would only fail.
  await supabase.auth.signOut({ scope: "local" });
}
