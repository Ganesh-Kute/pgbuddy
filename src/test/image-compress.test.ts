import { describe, expect, it } from "vitest";
import { classify, describeSize, extForType, fitWithin, LIMIT_BYTES, MB, prepareUpload, UploadRejected } from "@/lib/image-compress";

const fileOf = (bytes: number, name: string, type: string) => new File([new Uint8Array(bytes)], name, { type });

describe("image compression rules", () => {
  it("fits photos inside 1600 px without upscaling", () => {
    expect(fitWithin(4000, 3000)).toEqual({ width: 1600, height: 1200 });
    expect(fitWithin(3000, 4000)).toEqual({ width: 1200, height: 1600 });
    expect(fitWithin(800, 600)).toEqual({ width: 800, height: 600 });
    expect(fitWithin(0, 600)).toEqual({ width: 0, height: 0 });
  });

  it("knows photos, PDFs and everything else, also when the phone sends no type", () => {
    expect(classify({ type: "image/jpeg", name: "a.jpg" })).toBe("image");
    expect(classify({ type: "image/heic", name: "a.heic" })).toBe("image");
    expect(classify({ type: "", name: "IMG_1.PNG" })).toBe("image");
    expect(classify({ type: "application/pdf", name: "x" })).toBe("pdf");
    expect(classify({ type: "", name: "rent.pdf" })).toBe("pdf");
    expect(classify({ type: "application/zip", name: "x.zip" })).toBe("other");
    expect(classify({ type: "", name: "notes.docx" })).toBe("other");
  });

  it("names extensions after what is uploaded and sizes for people", () => {
    expect(extForType("image/webp")).toBe("webp");
    expect(extForType("image/jpeg")).toBe("jpg");
    expect(extForType("application/pdf")).toBe("pdf");
    expect(describeSize(2 * MB)).toBe("2.0 MB");
    expect(describeSize(150 * 1024)).toBe("150 KB");
    expect(LIMIT_BYTES).toEqual({ document: 2 * MB, photo: 3 * MB });
  });
});

describe("prepareUpload", () => {
  it("passes a PDF through untouched when it is under the limit", async () => {
    const pdf = fileOf(300 * 1024, "agreement.pdf", "application/pdf");
    const out = await prepareUpload(pdf, "document");
    expect(out).toMatchObject({ body: pdf, ext: "pdf", contentType: "application/pdf", finalBytes: 300 * 1024 });
  });

  it("refuses a PDF over 2 MB, a PDF as a property photo, and other file types, with a readable reason", async () => {
    await expect(prepareUpload(fileOf(3 * MB, "big.pdf", "application/pdf"))).rejects.toThrow(/limit is 2.0 MB/);
    await expect(prepareUpload(fileOf(100, "x.pdf", "application/pdf"), "photo")).rejects.toBeInstanceOf(UploadRejected);
    await expect(prepareUpload(fileOf(100, "x.zip", "application/zip"))).rejects.toThrow(/photo or a PDF/);
  });

  it("uploads an image it cannot decode as it is only when the server would accept it", async () => {
    // jsdom has no image decoder, which is the same path as an unreadable photo on a phone.
    const small = fileOf(200 * 1024, "proof.jpg", "image/jpeg");
    await expect(prepareUpload(small)).resolves.toMatchObject({ body: small, ext: "jpg", contentType: "image/jpeg" });
    await expect(prepareUpload(fileOf(5 * MB, "huge.jpg", "image/jpeg"))).rejects.toBeInstanceOf(UploadRejected);
    await expect(prepareUpload(fileOf(100, "a.heic", "image/heic"))).rejects.toThrow(/could not be opened/);
  });
});
