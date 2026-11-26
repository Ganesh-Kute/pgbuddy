import { useSyncExternalStore } from "react";
import { useIsFetching } from "@tanstack/react-query";
import { useDelayedFlag } from "@/hooks/useDelayedFlag";
import { pageLoads } from "@/lib/loadingActivity";

/** Shown only when a wait lasts longer than this, so fast loads never flicker. */
export const PROGRESS_DELAY_MS = 300;

/**
 * A thin bar at the top while a page file downloads or a page loads its data for the first time.
 * Background refreshes (data already on screen) never show it.
 */
export function TopProgressBar() {
  const pagesLoading = useSyncExternalStore(pageLoads.subscribe, pageLoads.count, pageLoads.count) > 0;
  const firstLoads = useIsFetching({ predicate: (q) => q.state.data === undefined }) > 0;
  const visible = useDelayedFlag(pagesLoading || firstLoads, PROGRESS_DELAY_MS);
  if (!visible) return null;
  return (
    <div
      role="progressbar"
      aria-label="Loading"
      className="fixed left-0 right-0 z-[100] h-[3px] overflow-hidden bg-primary/15 pointer-events-none"
      style={{ top: "env(safe-area-inset-top, 0px)" }}
    >
      <style>{`@keyframes pgb-progress{0%{transform:translateX(-100%)}100%{transform:translateX(250%)}}
@media (prefers-reduced-motion: reduce){.pgb-progress-bar{animation-duration:2.4s!important}}`}</style>
      <div
        className="pgb-progress-bar h-full w-2/5 bg-primary"
        style={{ animation: "pgb-progress 1.1s ease-in-out infinite" }}
      />
    </div>
  );
}
