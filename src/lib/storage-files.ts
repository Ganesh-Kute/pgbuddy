// Reading files from Supabase Storage once tenant-documents and payment-proofs are private.
//
// The database still holds the public URLs saved before (rent_payments.proof_url, utility_bills.proof_url,
// tenant_documents.url ...). Those stop working when a bucket goes private, so every place that shows a
// stored file passes it through here: the stored value (old public URL, signed URL or bare path) is
// turned back into a storage path and a short-lived signed URL is made for it. Nothing in the database
// has to be rewritten, and new uploads can keep storing whatever they store today.
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export type PrivateBucket = "tenant-documents" | "payment-proofs";
export type StorageBucket = PrivateBucket | "property-photos";

const PRIVATE_BUCKETS: ReadonlySet<string> = new Set<PrivateBucket>(["tenant-documents", "payment-proofs"]);

/** How long a signed link works. Long enough to read a document, short enough that a leaked link dies. */
export const SIGNED_URL_TTL_SECONDS = 60 * 60;

export function isPrivateBucket(bucket: string): bucket is PrivateBucket {
  return PRIVATE_BUCKETS.has(bucket);
}

/**
 * The object path inside `bucket` for a stored value, or null if the value points somewhere else.
 * Accepts `.../storage/v1/object/public/<bucket>/<path>`, `.../object/sign/<bucket>/<path>?token=...`,
 * `.../object/authenticated/<bucket>/<path>`, or a bare `<path>`.
 */
export function storagePathFromStored(bucket: string, stored: string | null | undefined): string | null {
  const value = (stored ?? "").trim();
  if (!value) return null;

  if (!/^https?:\/\//i.test(value)) {
    const path = value.replace(/^\/+/, "");
    // A bare value that names the bucket first ("payment-proofs/uid/x.png") is accepted too.
    const withoutBucket = path.startsWith(`${bucket}/`) ? path.slice(bucket.length + 1) : path;
    return withoutBucket && !withoutBucket.includes("..") ? withoutBucket : null;
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const marker = url.pathname.match(/\/storage\/v1\/object\/(?:public|sign|authenticated)\/([^/]+)\/(.+)$/);
  if (!marker || marker[1] !== bucket) return null;
  let path: string;
  try {
    path = decodeURIComponent(marker[2]);
  } catch {
    return null;
  }
  return path && !path.includes("..") ? path : null;
}

/** A URL the viewer can open now: signed for private buckets, the stored URL for public ones. */
export async function resolveStorageUrl(bucket: StorageBucket, stored: string | null | undefined): Promise<string | null> {
  if (!stored) return null;
  if (!isPrivateBucket(bucket)) return stored;
  const path = storagePathFromStored(bucket, stored);
  if (!path) return null;
  const { data, error } = await supabase.storage.from(bucket).createSignedUrl(path, SIGNED_URL_TTL_SECONDS);
  if (error || !data?.signedUrl) {
    console.warn(`[storage] could not sign ${bucket}/${path}:`, error?.message);
    return null;
  }
  return data.signedUrl;
}

/**
 * For images and previews: a signed URL, cached a little under its lifetime so a list does not re-sign
 * the same file on every render. `url` is null while loading and when the viewer may not read the file.
 */
export function useStorageUrl(bucket: StorageBucket, stored: string | null | undefined) {
  const query = useQuery({
    queryKey: ["storage-url", bucket, stored ?? ""],
    queryFn: () => resolveStorageUrl(bucket, stored),
    enabled: !!stored,
    staleTime: (SIGNED_URL_TTL_SECONDS - 5 * 60) * 1000,
    gcTime: SIGNED_URL_TTL_SECONDS * 1000,
    retry: false,
  });
  return { url: query.data ?? null, loading: query.isLoading && !!stored, failed: query.isError || query.data === null };
}

/**
 * For "View proof" / "Open document" buttons: sign only when tapped, then open. The tab is opened first
 * and pointed at the URL afterwards, because browsers block window.open after an await.
 * Returns false when the file cannot be opened (no access, deleted), so the caller can show a toast.
 */
export async function openStorageFile(bucket: StorageBucket, stored: string | null | undefined): Promise<boolean> {
  const tab = typeof window !== "undefined" ? window.open("", "_blank") : null;
  const url = await resolveStorageUrl(bucket, stored);
  if (!url) {
    tab?.close();
    return false;
  }
  if (tab) {
    tab.opener = null;
    tab.location.href = url;
  } else if (typeof window !== "undefined") {
    window.location.assign(url);
  }
  return true;
}
