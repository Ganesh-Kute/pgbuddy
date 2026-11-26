// The login Supabase keeps on the device (localStorage "sb-<project>-auth-token").
//
// Normally only Supabase touches it. The exception: on a network that never answers, Supabase holds
// its internal lock while a request waits, and its own sign-out waits for that lock too, so
// "Sign in again" did nothing (seen in Chromium with the database unreachable, 26 Nov 2026). Then the
// app removes the saved login itself and starts again from the sign-in page.

const SAVED_LOGIN_KEY = /^sb-.+-auth-token(-code-verifier)?$/;

/** Removes every saved Supabase login from this device. Returns how many entries it removed. */
export function forgetSavedLogin(storage: Storage = localStorage): number {
  const keys: string[] = [];
  try {
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      if (k && SAVED_LOGIN_KEY.test(k)) keys.push(k);
    }
    for (const k of keys) storage.removeItem(k);
  } catch {
    // Storage blocked: nothing saved to remove.
  }
  return keys.length;
}

/** Full page load of `path`: drops everything held in memory, including Supabase's stuck lock. */
export function restartAt(path: string): void {
  window.location.replace(path);
}
