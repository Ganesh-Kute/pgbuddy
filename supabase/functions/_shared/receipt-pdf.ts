// Renders a receipt PDF from the shared receipt model, and only from it: nothing the client sends ever
// reaches the page. Used by twilio-notifications (action send-payment-receipt) to send the receipt on
// WhatsApp as a document, and to return it for download.
//
// pdf-lib is passed in rather than imported, so this file loads in Deno (index.ts passes
// npm:pdf-lib@1.17.1) and in vitest (the test passes the npm package) without an import map.
//
// Only the standard Helvetica fonts are used, to keep the edge function's cold start small. They can
// only draw WinAnsi (Latin-1 plus a few signs), and pdf-lib throws on anything else, so every string
// goes through pdfText() first: the rupee sign becomes "Rs." and other scripts and emoji are dropped.

import { formatIndianNumber, type ReceiptModel } from "./receipt-model.ts";

/**
 * The parts of pdf-lib this file uses. The real module satisfies it structurally. Option fields are
 * optional, as in pdf-lib, so its own option types are assignable to these.
 */
export interface PdfFont {
  widthOfTextAtSize(text: string, size: number): number;
}

/** pdf-lib's Color (RGB, CMYK or Grayscale), as returned by rgb(). */
export interface PdfColor {
  type: string;
}

type Point = { x: number; y: number };

export interface PdfPage {
  drawText(text: string, options?: { x?: number; y?: number; size?: number; font?: PdfFont; color?: PdfColor }): void;
  drawLine(options: { start: Point; end: Point; thickness?: number; color?: PdfColor }): void;
  drawRectangle(options?: { x?: number; y?: number; width?: number; height?: number; color?: PdfColor }): void;
}

export interface PdfDocument {
  addPage(size: [number, number]): PdfPage;
  embedFont(font: string): Promise<PdfFont>;
  setTitle(title: string): void;
  setAuthor(author: string): void;
  setCreator(creator: string): void;
  setProducer(producer: string): void;
  setCreationDate(date: Date): void;
  setModificationDate(date: Date): void;
  save(): Promise<Uint8Array>;
}

export interface PdfLib {
  PDFDocument: { create(): Promise<PdfDocument> };
  StandardFonts: { Helvetica: string; HelveticaBold: string };
  rgb(red: number, green: number, blue: number): PdfColor;
}

// The characters WinAnsi has beyond printable ASCII and Latin-1 (0xA0-0xFF).
const WIN_ANSI_EXTRA = new Set("€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ");

/**
 * Make text safe for the standard PDF fonts. The rupee sign becomes "Rs.", whitespace and control
 * characters become single spaces, and anything else the font cannot draw (Devanagari, emoji) is dropped.
 * Returns `fallback` when nothing printable is left, so a name written only in Hindi still prints a label.
 */
export function pdfText(value: string | null | undefined, fallback = ""): string {
  let out = "";
  for (const ch of (value ?? "").normalize("NFC")) {
    const code = ch.codePointAt(0) ?? 0;
    if (code === 0x20b9) out += "Rs.";
    else if ((code >= 0x21 && code <= 0x7e) || (code >= 0xa1 && code <= 0xff) || WIN_ANSI_EXTRA.has(ch)) out += ch;
    else if (code <= 0x20 || code === 0xa0 || /\s/u.test(ch)) out += " ";
  }
  out = out.replace(/\s+/g, " ").trim();
  return out || fallback;
}

/** Split text into lines no wider than maxWidth. A single word longer than the line is cut. */
export function wrapText(text: string, font: PdfFont, size: number, maxWidth: number): string[] {
  const lines: string[] = [];
  let line = "";
  const fits = (t: string) => font.widthOfTextAtSize(t, size) <= maxWidth;
  for (const word of text.split(" ").filter(Boolean)) {
    const candidate = line ? `${line} ${word}` : word;
    if (fits(candidate)) {
      line = candidate;
      continue;
    }
    if (line) lines.push(line);
    let rest = word;
    while (!fits(rest) && rest.length > 1) {
      let cut = rest.length - 1;
      while (cut > 1 && !fits(rest.slice(0, cut))) cut--;
      lines.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    line = rest;
  }
  if (line) lines.push(line);
  return lines;
}

/** A5 portrait, in PDF points. Small enough to read on a phone without zooming far out. */
export const PAGE_SIZE: [number, number] = [420, 595];

export async function renderReceiptPdf(lib: PdfLib, receipt: ReceiptModel, now: Date = new Date()): Promise<Uint8Array> {
  const { rgb } = lib;
  const doc = await lib.PDFDocument.create();
  // Fixed metadata, so the same receipt renders to the same file (apart from these dates).
  doc.setTitle(pdfText(`${receipt.title} ${receipt.receiptNo}`));
  doc.setAuthor(pdfText(receipt.propertyName, "PG Buddy"));
  doc.setCreator("PG Buddy");
  doc.setProducer("PG Buddy");
  doc.setCreationDate(now);
  doc.setModificationDate(now);

  const [width, height] = PAGE_SIZE;
  const page = doc.addPage(PAGE_SIZE);
  const regular = await doc.embedFont(lib.StandardFonts.Helvetica);
  const bold = await doc.embedFont(lib.StandardFonts.HelveticaBold);

  const ink = rgb(0.12, 0.13, 0.16);
  const muted = rgb(0.42, 0.45, 0.5);
  const rule = rgb(0.85, 0.87, 0.9);
  const accent = rgb(0.13, 0.55, 0.33);
  const left = 32;
  const right = width - 32;
  const contentWidth = right - left;
  let y = height - 44;

  const text = (t: string, x: number, size: number, font: PdfFont = regular, color: PdfColor = ink) =>
    page.drawText(t, { x, y, size, font, color });
  const textRight = (t: string, size: number, font: PdfFont = regular, color: PdfColor = ink) =>
    text(t, right - font.widthOfTextAtSize(t, size), size, font, color);
  const hr = (gap = 12) => {
    page.drawLine({ start: { x: left, y }, end: { x: right, y }, thickness: 0.8, color: rule });
    y -= gap;
  };
  const paragraph = (t: string, size: number, font: PdfFont = regular, color: PdfColor = ink, maxWidth = contentWidth) => {
    for (const line of wrapText(t, font, size, maxWidth)) {
      text(line, left, size, font, color);
      y -= size + 4;
    }
  };

  // Header: who issued it.
  paragraph(pdfText(receipt.propertyName, "PG"), 16, bold);
  const address = pdfText(receipt.propertyAddress);
  if (address) paragraph(address, 9, regular, muted);
  const owner = pdfText(receipt.ownerName);
  if (owner) paragraph(`Managed by ${owner}`, 9, regular, muted);
  y -= 6;
  hr(22);

  // Title row, with the status badge on the right.
  text(pdfText(receipt.title, "Payment Receipt"), left, 13, bold);
  const status = pdfText(receipt.statusLabel, "Paid").toUpperCase();
  const badgeWidth = bold.widthOfTextAtSize(status, 9) + 16;
  const badgeColor = receipt.isPaid ? accent : muted;
  page.drawRectangle({ x: right - badgeWidth, y: y - 5, width: badgeWidth, height: 17, color: badgeColor });
  page.drawText(status, { x: right - badgeWidth + 8, y: y, size: 9, font: bold, color: rgb(1, 1, 1) });
  y -= 22;

  const detail = (label: string, value: string) => {
    text(label, left, 9, regular, muted);
    const lines = wrapText(value, bold, 10, contentWidth - 110);
    lines.forEach((line, i) => {
      text(line, left + 110, 10, bold);
      if (i < lines.length - 1) y -= 14;
    });
    y -= 17;
  };
  detail("Receipt no.", pdfText(receipt.receiptNo));
  detail("Date", pdfText(receipt.issuedOn));
  detail("Received from", pdfText(receipt.tenantName, "Tenant"));
  detail("Room", pdfText(receipt.roomNumber, "-"));
  y -= 4;
  hr(18);

  // Line items.
  text("Description", left, 9, bold, muted);
  textRight("Amount", 9, bold, muted);
  y -= 16;
  for (const line of receipt.lines) {
    const amount = `Rs. ${formatIndianNumber(line.amount)}`;
    const labelLines = wrapText(pdfText(line.label, "Payment"), regular, 10, contentWidth - 110);
    textRight(amount, 10);
    labelLines.forEach((l, i) => {
      text(l, left, 10);
      if (i < labelLines.length - 1) y -= 14;
    });
    y -= 18;
  }
  hr(20);
  text("Total paid", left, 12, bold);
  textRight(pdfText(receipt.totalText), 12, bold);
  y -= 16;
  paragraph(pdfText(receipt.totalInWords), 9, regular, muted);
  y -= 10;

  detail("Paid via", pdfText(receipt.method, "-"));
  detail("Transaction ID", pdfText(receipt.transactionId, "-"));

  // Footer, pinned to the bottom of the page.
  y = 44;
  hr(14);
  paragraph("This is a computer-generated receipt and does not need a signature.", 8, regular, muted);
  paragraph("Sent with PG Buddy", 8, regular, muted);

  return doc.save();
}
