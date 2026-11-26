// @vitest-environment node
// A receipt PDF that arrives as a byte VIEW (e.g. a subarray of a bigger buffer) must become a file of
// exactly those bytes. The old code used view.buffer, the WHOLE underlying buffer, so the downloaded
// file could carry extra bytes before and after the PDF. (Found 26 Nov 2026 while fixing the CI type
// error that TypeScript 5.9 reports on that same line.)
import { describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({ supabase: { functions: { invoke: vi.fn() } } }));

const { pdfBlobFromBytes } = await import("@/hooks/useWhatsAppNotify");

const bytesOf = async (b: Blob) => [...new Uint8Array(await b.arrayBuffer())];

describe("pdfBlobFromBytes", () => {
  it("a view over part of a buffer gives only the viewed bytes", async () => {
    const whole = new Uint8Array([9, 9, 9, 37, 80, 68, 70, 9, 9]); // "%PDF" sits at offset 3
    const view = whole.subarray(3, 7);
    const blob = pdfBlobFromBytes(view);
    expect(await bytesOf(blob)).toEqual([37, 80, 68, 70]);
    expect(blob.type).toBe("application/pdf");
  });

  it("an ArrayBuffer is used as it is", async () => {
    const blob = pdfBlobFromBytes(new Uint8Array([37, 80, 68, 70]).buffer);
    expect(await bytesOf(blob)).toEqual([37, 80, 68, 70]);
  });

  it("a DataView over part of a buffer also gives only its bytes", async () => {
    const whole = new Uint8Array([1, 37, 80, 68, 70, 2]);
    const blob = pdfBlobFromBytes(new DataView(whole.buffer, 1, 4));
    expect(await bytesOf(blob)).toEqual([37, 80, 68, 70]);
  });
});
