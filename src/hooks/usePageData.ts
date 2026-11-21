import { useCallback, useLayoutEffect, useRef } from "react";
import { useQuery, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { useAuth } from "@/hooks/useAuth";

/** Every page's data lives under this key prefix, so one write can mark all of it stale. */
export const PAGE_DATA = "page-data";

/**
 * Cached data loading for a page that keeps its rows in local state.
 *
 * `load` fetches and returns a snapshot; `apply` copies it into the page's state. The snapshot is
 * cached (QueryClient defaults: fresh for 60 s), so going back to a page renders its last data at
 * once instead of a spinner and a refetch. `apply` runs in a layout effect, before the browser
 * paints, so a cached page never flashes its loading state.
 *
 * Call `refresh()` after a write. It marks every page's cache stale, since a write on one page often
 * shows on another (a new tenant changes Rooms and the Dashboard), and refetches this page now.
 */
export function usePageData<T>(
  key: QueryKey,
  load: () => Promise<T>,
  apply: (data: T) => void,
  enabled = true,
) {
  const queryClient = useQueryClient();
  // Always keyed by who is asking: an owner and their staff share an owner id but see different rows.
  const { user } = useAuth();
  const queryKey = [PAGE_DATA, user?.id ?? null, ...key];
  // No structural sharing: every fetch is a new snapshot, so `apply` always runs after a refresh,
  // even when the rows are unchanged and the page had edited its local copy in the meantime.
  const query = useQuery({ queryKey, queryFn: load, enabled, structuralSharing: false });

  // The newest `apply` without re-running the effect for each render's new closure.
  const applyRef = useRef(apply);
  applyRef.current = apply;
  useLayoutEffect(() => {
    if (query.data !== undefined) applyRef.current(query.data);
  }, [query.data]);

  const keyJson = JSON.stringify(queryKey);
  const refresh = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: [PAGE_DATA], refetchType: "none" });
    await queryClient.refetchQueries({ queryKey: JSON.parse(keyJson), exact: true });
  }, [queryClient, keyJson]);

  return {
    /** True only while there is nothing to show yet. A background refresh keeps the old rows. */
    loading: enabled && query.isPending,
    error: query.error,
    refresh,
  };
}

/** A queued state update. It is given the setters of the page that is on screen when it is applied. */
type Commit<S> = (setters: S) => void;

/**
 * For a loader that sets several pieces of state. Inside the loader, `later((s) => s.setRooms(rows))`
 * queues the update instead of making it, and `later.commits` is the queue. The loader returns the
 * queue as its snapshot and `applyTo(setters)` runs it against the setters of the page as it is now,
 * which matters for a cached snapshot replayed into a page that has been mounted again since.
 */
export function deferSetters<S>() {
  const commits: Commit<S>[] = [];
  const later = (commit: Commit<S>) => {
    commits.push(commit);
  };
  return Object.assign(later, { commits });
}

export const applyTo = <S,>(setters: S) => (commits: Commit<S>[]) => commits.forEach((c) => c(setters));
