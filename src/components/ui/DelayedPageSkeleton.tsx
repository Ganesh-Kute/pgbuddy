import { PageSkeleton, type PageSkeletonVariant } from "@/components/ui/PageSkeleton";
import { useDelayedFlag } from "@/hooks/useDelayedFlag";

export const PAGE_SKELETON_DELAY_MS = 150;

/**
 * Delays showing `PageSkeleton` by `delayMs` (150 ms default) while reserving vertical space with
 * `aria-busy="true"`, so fast/cached loads never flicker and slow loads never flash empty states or
 * raw "Loading..." text (T4).
 */
export function DelayedPageSkeleton({
  loading = true,
  delayMs = PAGE_SKELETON_DELAY_MS,
  variant = "list",
  count = 5,
}: {
  loading?: boolean;
  delayMs?: number;
  variant?: PageSkeletonVariant;
  count?: number;
}) {
  const show = useDelayedFlag(loading, delayMs);
  if (!loading) return null;
  if (!show) {
    return <div role="status" aria-busy="true" aria-label="Loading" className="min-h-[200px] w-full" />;
  }
  return <PageSkeleton variant={variant} count={count} />;
}
