// Renders a receipt PDF from the shared receipt model, and only from it: nothing the client sends ever
// reaches the page. Used by twilio-notifications (action send-payment-receipt) to send the receipt on
// WhatsApp as a document, and to return it for download.
//
// pdf-lib is passed in rather than imported, so this file loads in Deno (index.ts passes
// npm:pdf-lib@1.17.1) and in vitest (the test passes the npm package) without an import map.
//
// Only the standard Helvetica fonts are used, and no images, to keep the edge function's cold start and
// the file small (a few KB). Those fonts can only draw WinAnsi (Latin-1 plus a few signs), and pdf-lib
// throws on anything else, so every string goes through pdfText() first: the rupee sign becomes "Rs."
// and other scripts and emoji are dropped, with a fallback when nothing is left.
//
// The design: the PG's name is the brand at the top, PG Buddy is a small line in the footer.

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
  drawRectangle(options?: {
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    color?: PdfColor;
    borderColor?: PdfColor;
    borderWidth?: number;
  }): void;
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
 * Returns `fallback` when no letter or digit is left, so a name written only in Hindi still prints a label.
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
  // What is left of "(रवि)" is "()": not worth printing.
  return /[A-Za-z0-9À-ÿ]/.test(out) ? out : fallback;
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

/** One line, cut to fit with "…" when it is too wide. */
export function ellipsize(text: string, font: PdfFont, size: number, maxWidth: number): string {
  if (font.widthOfTextAtSize(text, size) <= maxWidth) return text;
  let cut = text;
  while (cut.length > 1 && font.widthOfTextAtSize(`${cut}…`, size) > maxWidth) cut = cut.slice(0, -1);
  return `${cut.trimEnd()}…`;
}

/** wrapText, then at most `maxLines` lines; when text is cut, the last line ends in "…". */
export function clampLines(text: string, font: PdfFont, size: number, maxWidth: number, maxLines: number): string[] {
  // One line: cut by characters, so a long unbroken value stays next to its label.
  if (maxLines <= 1) return text ? [ellipsize(text, font, size, maxWidth)] : [];
  const lines = wrapText(text, font, size, maxWidth);
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  let last = `${kept[maxLines - 1]}…`;
  while (last.length > 1 && font.widthOfTextAtSize(last, size) > maxWidth) {
    last = `${last.slice(0, -2).trimEnd()}…`;
  }
  kept[maxLines - 1] = last;
  return kept;
}

/** A5 portrait, in PDF points. Small enough to read on a phone without zooming far out. */
export const PAGE_SIZE: [number, number] = [420, 595];

export async function renderReceiptPdf(lib: PdfLib, receipt: ReceiptModel, now: Date = new Date()): Promise<Uint8Array> {
  const r = receipt;
  const { rgb } = lib;
  const doc = await lib.PDFDocument.create();
  doc.setTitle(pdfText(`${r.title} ${r.receiptNo}`, r.receiptNo));
  doc.setAuthor(pdfText(r.propertyName, "PG"));
  doc.setCreator("PG Buddy");
  doc.setProducer("PG Buddy");
  doc.setCreationDate(now);
  doc.setModificationDate(now);

  const [width, height] = PAGE_SIZE;
  const page = doc.addPage(PAGE_SIZE);
  const regular = await doc.embedFont(lib.StandardFonts.Helvetica);
  const bold = await doc.embedFont(lib.StandardFonts.HelveticaBold);

  // One accent colour, neutral greys, and the two status colours for the stamp.
  const accent = rgb(0.31, 0.275, 0.898); // #4F46E5
  const accentTint = rgb(0.933, 0.949, 1); // #EEF2FF
  const ink = rgb(0.067, 0.094, 0.153); // #111827
  const muted = rgb(0.42, 0.447, 0.502); // #6B7280
  const rule = rgb(0.898, 0.906, 0.922); // #E5E7EB
  const zebra = rgb(0.976, 0.98, 0.984); // #F9FAFB
  const white = rgb(1, 1, 1);
  const paidGreen = rgb(0.086, 0.639, 0.29); // #16A34A
  const pendingAmber = rgb(0.851, 0.467, 0.024); // #D97706

  const left = 30;
  const right = width - 30;
  const contentWidth = right - left;

  const draw = (t: string, x: number, y: number, size: number, font: PdfFont = regular, color: PdfColor = ink) =>
    page.drawText(t, { x, y, size, font, color });
  const drawRight = (t: string, xRight: number, y: number, size: number, font: PdfFont = regular, color: PdfColor = ink) =>
    draw(t, xRight - font.widthOfTextAtSize(t, size), y, size, font, color);
  const hline = (y: number, color: PdfColor = rule, thickness = 0.8, x1 = left, x2 = right) =>
    page.drawLine({ start: { x: x1, y }, end: { x: x2, y }, thickness, color });
  /** Draw lines downward from y (the first baseline). Returns the y below the last line. */
  const block = (lines: string[], x: number, y: number, size: number, font: PdfFont, color: PdfColor, leading = size + 3) => {
    lines.forEach((line, i) => draw(line, x, y - i * leading, size, font, color));
    return y - lines.length * leading;
  };

  const propertyName = pdfText(r.propertyName, "PG");
  const ownerName = pdfText(r.ownerName);
  const tenantName = pdfText(r.tenantName, "Tenant");
  const period = pdfText(r.period);

  // Accent band across the top edge.
  page.drawRectangle({ x: 0, y: height - 6, width, height: 6, color: accent });

  // Header. Right column: what this is, its number and its date. Left column: the PG, as the brand.
  const rightColWidth = 138;
  const leftColWidth = contentWidth - rightColWidth - 16;
  const top = height - 40;

  const label = r.kind === "deposit" ? "SECURITY DEPOSIT RECEIPT" : "PAYMENT RECEIPT";
  drawRight(label, right, top, 8.5, bold, accent);
  drawRight(pdfText(r.receiptNo), right, top - 16, 11, bold, ink);
  drawRight(`Date: ${pdfText(r.issuedOn)}`, right, top - 30, 8.5, regular, muted);

  let y = block(clampLines(propertyName, bold, 18, leftColWidth, 2), left, top - 4, 18, bold, ink, 21);
  const address = pdfText(r.propertyAddress);
  if (address) y = block(clampLines(address, regular, 8.5, leftColWidth, 2), left, y - 2, 8.5, regular, muted, 11);
  const phone = pdfText(r.ownerPhone);
  if (phone) y = block([`Phone: ${phone}`], left, y - 2, 8.5, regular, muted, 11);

  y = Math.min(y, top - 44) - 10;
  hline(y);
  y -= 22;

  // Details grid: two columns, two rows. The status stamp sits in the last cell.
  const colGap = 16;
  const colWidth = (contentWidth - colGap) / 2;
  const col2 = left + colWidth + colGap;
  const cell = (x: number, cellTop: number, heading: string, primary: string, secondary?: string) => {
    draw(heading.toUpperCase(), x, cellTop, 7, bold, muted);
    let cy = block(clampLines(primary, bold, 10, colWidth, 2), x, cellTop - 14, 10, bold, ink, 13);
    if (secondary) cy = block(clampLines(secondary, regular, 8.5, colWidth, 1), x, cy - 1, 8.5, regular, muted, 11);
    return cy;
  };
  const roomNumber = pdfText(r.roomNumber, "-");
  const transactionId = pdfText(r.transactionId, "-");
  y = Math.min(
    cell(left, y, "Received from", tenantName, roomNumber !== "-" ? `Room ${roomNumber}` : undefined),
    cell(col2, y, "Payment", pdfText(r.method, "-"), transactionId !== "-" ? `Txn ID: ${transactionId}` : undefined),
  ) - 12;

  const rowTwoTop = y;
  const forText = r.kind === "deposit" ? "Security deposit" : period || pdfText(r.lines[0]?.label, "Payment");
  const rowTwoBottom = cell(left, rowTwoTop, r.kind === "deposit" || !period ? "For" : "Period", forText);

  // Status stamp: a filled pill.
  draw("STATUS", col2, rowTwoTop, 7, bold, muted);
  const status = r.isPaid ? "PAID" : "PENDING";
  const pillWidth = bold.widthOfTextAtSize(status, 9) + 20;
  page.drawRectangle({ x: col2, y: rowTwoTop - 20, width: pillWidth, height: 16, color: r.isPaid ? paidGreen : pendingAmber });
  draw(status, col2 + 10, rowTwoTop - 15, 9, bold, white);

  y = Math.min(rowTwoBottom, rowTwoTop - 24) - 16;

  // Line items: header band, zebra rows, bold total row.
  const rowHeight = 20;
  const amountColumn = 110;
  page.drawRectangle({ x: left, y: y - rowHeight + 6, width: contentWidth, height: rowHeight, color: accentTint });
  draw("DESCRIPTION", left + 10, y - 7, 7.5, bold, accent);
  drawRight("AMOUNT", right - 10, y - 7, 7.5, bold, accent);
  y -= rowHeight;
  r.lines.forEach((line, i) => {
    const labelLines = clampLines(pdfText(line.label, "Payment"), regular, 9.5, contentWidth - amountColumn - 20, 2);
    const h = rowHeight + (labelLines.length - 1) * 12;
    if (i % 2 === 1) page.drawRectangle({ x: left, y: y - h + 6, width: contentWidth, height: h, color: zebra });
    block(labelLines, left + 10, y - 7, 9.5, regular, ink, 12);
    drawRight(`Rs. ${formatIndianNumber(line.amount)}`, right - 10, y - 7, 9.5, regular, ink);
    y -= h;
  });
  hline(y + 4, ink, 0.8);
  draw("Total", left + 10, y - 9, 10, bold, ink);
  drawRight(pdfText(r.totalText), right - 10, y - 9, 10, bold, ink);
  y -= rowHeight + 14;

  // Amount box: the figure large, the words under it.
  const words = clampLines(pdfText(r.totalInWords), regular, 8.5, contentWidth - 34, 2);
  const boxHeight = 52 + words.length * 11;
  page.drawRectangle({ x: left, y: y - boxHeight, width: contentWidth, height: boxHeight, color: accentTint });
  page.drawRectangle({ x: left, y: y - boxHeight, width: 4, height: boxHeight, color: accent });
  draw(r.kind === "deposit" ? "DEPOSIT RECEIVED" : "AMOUNT RECEIVED", left + 16, y - 16, 7.5, bold, accent);
  draw(pdfText(r.totalText), left + 16, y - 38, 20, bold, ink);
  block(words, left + 16, y - 54, 8.5, regular, muted, 11);

  // Signature line, bottom right.
  const signY = 104;
  const signWidth = 150;
  hline(signY, muted, 0.6, right - signWidth, right);
  const signer = clampLines(ownerName ? `Received by ${ownerName}` : `${propertyName} management`, regular, 8.5, signWidth, 2);
  signer.forEach((line, i) => drawRight(line, right, signY - 12 - i * 11, 8.5, regular, muted));

  // Footer: the disclaimer, then PG Buddy, small.
  hline(52);
  draw("This is a computer-generated receipt and does not require a signature.", left, 38, 7.5, regular, muted);
  const powered = "Powered by ";
  draw(powered, left, 26, 7.5, regular, muted);
  draw("PG Buddy", left + regular.widthOfTextAtSize(powered, 7.5), 26, 7.5, bold, muted);
  drawRight(pdfText(r.receiptNo), right, 26, 7.5, regular, muted);

  return doc.save();
}
