import { useEffect, useSyncExternalStore } from "react";
import { WifiOff } from "lucide-react";
import { network, watchBrowserNetwork } from "@/lib/loadingActivity";

/** "You're offline" while the device has no connection or the server cannot be reached. */
export function OfflineBanner() {
  useEffect(() => watchBrowserNetwork(), []);
  const offline = useSyncExternalStore(network.subscribe, network.isOffline, network.isOffline);
  if (!offline) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed left-1/2 z-[99] -translate-x-1/2 pointer-events-none"
      style={{ top: "calc(env(safe-area-inset-top, 0px) + 64px)" }}
    >
      <div className="flex items-center gap-2 rounded-full bg-amber-100 px-4 py-2 text-sm font-medium text-amber-900 shadow-lg dark:bg-amber-900 dark:text-amber-50">
        <WifiOff className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span className="whitespace-nowrap">You're offline</span>
      </div>
    </div>
  );
}
