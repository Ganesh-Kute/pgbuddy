// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

const createSignedUrl = vi.fn();
vi.mock("@/integrations/supabase/client", () => ({
  supabase: { storage: { from: () => ({ createSignedUrl }) } },
}));

const { isPrivateBucket, resolveStorageUrl, storagePathFromStored } = await import("@/lib/storage-files");

const base = "https://vcpohetbsyyjqqkzuzxj.supabase.co/storage/v1/object";

describe("storagePathFromStored", () => {
  it("reads the path out of the public URLs already saved in the database", () => {
    expect(storagePathFromStored("payment-proofs", `${base}/public/payment-proofs/u1/p1.png`)).toBe("u1/p1.png");
    expect(storagePathFromStored("payment-proofs", `${base}/public/payment-proofs/utility/u1/b1.jpg`)).toBe("utility/u1/b1.jpg");
    expect(storagePathFromStored("tenant-documents", `${base}/public/tenant-documents/a1/171_my%20aadhaar.pdf`)).toBe("a1/171_my aadhaar.pdf");
  });

  it("reads signed and authenticated URLs too", () => {
    expect(storagePathFromStored("tenant-documents", `${base}/sign/tenant-documents/u1/x.pdf?token=abc`)).toBe("u1/x.pdf");
    expect(storagePathFromStored("tenant-documents", `${base}/authenticated/tenant-documents/u1/x.pdf`)).toBe("u1/x.pdf");
  });

  it("accepts bare paths, with or without the bucket name first", () => {
    expect(storagePathFromStored("payment-proofs", "u1/p1.png")).toBe("u1/p1.png");
    expect(storagePathFromStored("payment-proofs", "/payment-proofs/u1/p1.png")).toBe("u1/p1.png");
  });

  it("refuses other buckets, other sites, traversal and junk", () => {
    expect(storagePathFromStored("payment-proofs", `${base}/public/tenant-documents/u1/x.pdf`)).toBeNull();
    expect(storagePathFromStored("payment-proofs", "https://evil.example/u1/p1.png")).toBeNull();
    expect(storagePathFromStored("payment-proofs", "u1/../../secret")).toBeNull();
    expect(storagePathFromStored("payment-proofs", `${base}/public/payment-proofs/u1/%E0%A4`)).toBeNull();
    expect(storagePathFromStored("payment-proofs", "")).toBeNull();
    expect(storagePathFromStored("payment-proofs", null)).toBeNull();
  });
});

describe("resolveStorageUrl", () => {
  it("signs private files for one hour", async () => {
    createSignedUrl.mockResolvedValueOnce({ data: { signedUrl: "https://signed/x" }, error: null });
    await expect(resolveStorageUrl("payment-proofs", `${base}/public/payment-proofs/u1/p1.png`)).resolves.toBe("https://signed/x");
    expect(createSignedUrl).toHaveBeenLastCalledWith("u1/p1.png", 3600);
  });

  it("returns null when the viewer may not read the file", async () => {
    createSignedUrl.mockResolvedValueOnce({ data: null, error: { message: "Object not found" } });
    await expect(resolveStorageUrl("tenant-documents", "u2/secret.pdf")).resolves.toBeNull();
  });

  it("leaves public property photos alone", async () => {
    createSignedUrl.mockClear();
    const url = `${base}/public/property-photos/prop/1.webp`;
    await expect(resolveStorageUrl("property-photos", url)).resolves.toBe(url);
    expect(createSignedUrl).not.toHaveBeenCalled();
    expect(isPrivateBucket("property-photos")).toBe(false);
    expect(isPrivateBucket("tenant-documents")).toBe(true);
  });
});
