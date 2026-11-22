import { useState, type ReactNode } from "react";
import { useToast } from "@/hooks/use-toast";
import { openStorageFile, type StorageBucket } from "@/lib/storage-files";

type Props = {
  bucket: StorageBucket;
  /** What the database stores for the file: an old public URL, a signed URL or a storage path. */
  stored: string | null | undefined;
  className?: string;
  children: ReactNode;
};

/**
 * A link to a file in Supabase Storage. Tenant files are private, so the link is signed when tapped
 * (valid for an hour) instead of pointing at a public URL that no longer opens.
 */
export const StorageFileLink = ({ bucket, stored, className, children }: Props) => {
  const { toast } = useToast();
  const [opening, setOpening] = useState(false);

  const open = async (e: React.MouseEvent) => {
    e.preventDefault();
    if (opening) return;
    setOpening(true);
    try {
      const ok = await openStorageFile(bucket, stored);
      if (!ok) {
        toast({ title: "Could not open the file", description: "It may have been removed, or you may not have access.", variant: "destructive" });
      }
    } finally {
      setOpening(false);
    }
  };

  return (
    <a href="#" role="button" onClick={open} aria-busy={opening} className={className}>
      {children}
    </a>
  );
};
