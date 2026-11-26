import { Skeleton } from "@/components/ui/skeleton";

export type PageSkeletonVariant = "list" | "cards" | "table" | "detail";

/**
 * Placeholder for a page's own data while it loads, in the shape of what will appear, so the page
 * does not jump when the data arrives. Use it instead of a "Loading..." line (T4).
 *
 *   if (isLoading) return <PageSkeleton variant="cards" count={4} />;
 */
export function PageSkeleton({ variant = "list", count = 5 }: { variant?: PageSkeletonVariant; count?: number }) {
  const items = Array.from({ length: Math.max(1, count) });
  return (
    <div role="status" aria-busy="true" aria-live="polite" className="w-full">
      <span className="sr-only">Loading</span>
      {variant === "cards" && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {items.map((_, i) => (
            <div key={i} className="rounded-xl border border-border/50 bg-card/50 p-5">
              <Skeleton className="mb-4 h-4 w-24" />
              <Skeleton className="mb-2 h-7 w-20" />
              <Skeleton className="h-3 w-32" />
            </div>
          ))}
        </div>
      )}
      {variant === "list" && (
        <div className="space-y-3">
          {items.map((_, i) => (
            <div key={i} className="flex items-center gap-3 rounded-xl border border-border/50 bg-card/50 p-4">
              <Skeleton className="h-10 w-10 shrink-0 rounded-full" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-4 w-2/5" />
                <Skeleton className="h-3 w-3/5" />
              </div>
              <Skeleton className="h-8 w-16 rounded-lg" />
            </div>
          ))}
        </div>
      )}
      {variant === "table" && (
        <div className="overflow-hidden rounded-xl border border-border/50">
          <Skeleton className="h-10 w-full rounded-none" />
          {items.map((_, i) => (
            <div key={i} className="flex gap-4 border-t border-border/50 p-3">
              <Skeleton className="h-4 flex-1" />
              <Skeleton className="h-4 w-20" />
              <Skeleton className="h-4 w-16" />
            </div>
          ))}
        </div>
      )}
      {variant === "detail" && (
        <div className="space-y-4 rounded-xl border border-border/50 bg-card/50 p-6">
          <Skeleton className="h-6 w-48" />
          {items.map((_, i) => (
            <div key={i} className="flex justify-between gap-4">
              <Skeleton className="h-4 w-28" />
              <Skeleton className="h-4 w-36" />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
