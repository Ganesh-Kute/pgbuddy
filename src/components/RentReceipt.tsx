import { useState } from "react";
import { Capacitor } from "@capacitor/core";
import { CheckCircle, Download, FileText, Printer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { buildReceipt, formatIndianNumber } from "@/lib/receipt";
import { getAppName } from "@/lib/branding";

export interface ReceiptProps {
  payment: {
    id: string;
    amount: number;
    month: string;
    payment_date: string | null;
    created_at?: string | null;
    status: string;
    payment_type?: string;
    payment_method?: string | null;
    transaction_id?: string | null;
    tenant_name?: string | null;
    properties?: { name: string; owner_name?: string; address?: string } | null;
    rooms?: { room_number: string } | null;
  };
  tenantName?: string;
  onDownloadPdf?: () => Promise<void> | void;
  downloadingPdf?: boolean;
  downloadLabel?: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const RentReceipt = ({
  payment,
  tenantName,
  onDownloadPdf,
  downloadingPdf = false,
  downloadLabel = "Download PDF",
}: ReceiptProps) => {
  const [open, setOpen] = useState(false);

  if (payment.status !== "paid") return null;

  const receipt = buildReceipt(
    {
      id: payment.id,
      amount: payment.amount,
      month: payment.month,
      payment_date: payment.payment_date,
      created_at: payment.created_at,
      status: payment.status,
      payment_type: payment.payment_type,
      payment_method: payment.payment_method,
      transaction_id: payment.transaction_id,
    },
    {
      tenantName: tenantName || payment.tenant_name,
      propertyName: payment.properties?.name,
      propertyAddress: payment.properties?.address,
      ownerName: payment.properties?.owner_name,
      roomNumber: payment.rooms?.room_number,
    },
  );

  const isNative = Capacitor.isNativePlatform();

  const handlePrint = () => {
    const win = window.open("", "_blank");
    if (!win) return;

    const lineRows = receipt.lines
      .map(
        (line) => `
          <tr>
            <td>${escapeHtml(line.label)}</td>
            <td class="right">Rs. ${escapeHtml(formatIndianNumber(line.amount))}</td>
          </tr>`,
      )
      .join("");

    win.document.write(`<!DOCTYPE html>
<html>
<head>
  <title>${escapeHtml(receipt.receiptNo)} - ${escapeHtml(receipt.title)}</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; padding: 32px; max-width: 760px; margin: 0 auto; color: #0f172a; }
    .header { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #e2e8f0; padding-bottom: 20px; margin-bottom: 28px; }
    .brand { font-size: 22px; font-weight: 700; color: #7c3aed; }
    .brand-sub { font-size: 12px; color: #64748b; margin-top: 4px; }
    .title-area { text-align: right; }
    .title-area h1 { font-size: 18px; margin: 0 0 6px 0; }
    .meta { font-size: 13px; color: #475569; margin: 2px 0; }
    .meta strong { color: #0f172a; }
    .parties { display: flex; justify-content: space-between; gap: 24px; margin-bottom: 28px; }
    .party { width: 48%; }
    .party.right { text-align: right; }
    .label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: #64748b; font-weight: 700; margin-bottom: 6px; }
    .name { font-size: 16px; font-weight: 700; margin: 0 0 4px 0; }
    .detail { font-size: 13px; color: #475569; margin: 2px 0; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 16px; border: 1px solid #e2e8f0; }
    th, td { padding: 12px 16px; text-align: left; border-bottom: 1px solid #e2e8f0; font-size: 14px; }
    th { background: #f8fafc; font-size: 12px; text-transform: uppercase; color: #334155; }
    th.right, td.right { text-align: right; font-weight: 700; }
    tr.total td { background: #f8fafc; font-weight: 700; }
    tr.total td.right { font-size: 18px; color: #7c3aed; }
    .words { font-size: 12px; color: #475569; margin-bottom: 20px; }
    .tx { background: #f8fafc; border: 1px solid #e2e8f0; padding: 14px 16px; border-radius: 6px; display: flex; justify-content: space-between; align-items: center; }
    .badge { background: #dcfce7; color: #166534; padding: 6px 12px; border-radius: 9999px; font-size: 12px; font-weight: 700; }
    .footer { margin-top: 32px; border-top: 1px solid #e2e8f0; padding-top: 14px; font-size: 11px; color: #64748b; text-align: center; }
  </style>
</head>
<body>
  <div class="header">
    <div>
      <div class="brand">${escapeHtml(getAppName())}</div>
      <div class="brand-sub">Digital Receipt Validation</div>
    </div>
    <div class="title-area">
      <h1>${escapeHtml(receipt.title)}</h1>
      <div class="meta">Receipt No: <strong>${escapeHtml(receipt.receiptNo)}</strong></div>
      <div class="meta">Date: <strong>${escapeHtml(receipt.issuedOn)}</strong></div>
    </div>
  </div>
  <div class="parties">
    <div class="party">
      <div class="label">Received From</div>
      <p class="name">${escapeHtml(receipt.tenantName)}</p>
      <p class="detail">Room: <strong>${escapeHtml(receipt.roomNumber)}</strong></p>
    </div>
    <div class="party right">
      <div class="label">Paid To</div>
      <p class="name">${escapeHtml(receipt.propertyName)}</p>
      ${receipt.ownerName ? `<p class="detail">${escapeHtml(receipt.ownerName)}</p>` : ""}
      ${receipt.propertyAddress ? `<p class="detail">${escapeHtml(receipt.propertyAddress)}</p>` : ""}
    </div>
  </div>
  <table>
    <thead>
      <tr>
        <th>Description</th>
        <th class="right">Amount</th>
      </tr>
    </thead>
    <tbody>
      ${lineRows}
      <tr class="total">
        <td>Total Paid</td>
        <td class="right">${escapeHtml(receipt.totalText)}</td>
      </tr>
    </tbody>
  </table>
  ${receipt.totalInWords ? `<div class="words"><strong>Amount in words:</strong> ${escapeHtml(receipt.totalInWords)}</div>` : ""}
  <div class="tx">
    <div>
      <div class="meta">Payment Method: <strong>${escapeHtml(receipt.method)}</strong></div>
      ${receipt.transactionId !== "-" ? `<div class="meta">Reference: <strong>${escapeHtml(receipt.transactionId)}</strong></div>` : ""}
    </div>
    <div class="badge">PAYMENT VERIFIED</div>
  </div>
  <div class="footer">This is a computer-generated receipt from ${escapeHtml(getAppName())}. No physical signature is required.</div>
</body>
</html>`);
    win.document.close();
    setTimeout(() => {
      win.print();
    }, 300);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="gap-1.5 text-xs min-h-[44px] sm:min-h-0"
        >
          <FileText className="w-3.5 h-3.5" />
          Receipt
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center justify-between gap-2 pr-6">
            <span>{receipt.title}</span>
            <span className="text-xs font-mono text-muted-foreground">{receipt.receiptNo}</span>
          </DialogTitle>
          <DialogDescription>
            Issued on {receipt.issuedOn} for {receipt.tenantName}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 text-sm">
          <div className="flex items-start justify-between gap-4 pb-3 border-b border-border">
            <div>
              <p className="font-bold text-primary">{getAppName()}</p>
              <p className="text-xs text-muted-foreground">Digital Receipt Validation</p>
            </div>
            <div className="text-right">
              <p className="text-xs text-muted-foreground">Issued On</p>
              <p className="font-semibold">{receipt.issuedOn}</p>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="rounded-lg bg-muted/40 p-3 space-y-1">
              <p className="text-[11px] uppercase tracking-wider font-semibold text-muted-foreground">
                Received From
              </p>
              <p className="font-semibold">{receipt.tenantName}</p>
              <p className="text-xs text-muted-foreground">Room: {receipt.roomNumber}</p>
            </div>
            <div className="rounded-lg bg-muted/40 p-3 space-y-1 sm:text-right">
              <p className="text-[11px] uppercase tracking-wider font-semibold text-muted-foreground">
                Paid To
              </p>
              <p className="font-semibold">{receipt.propertyName}</p>
              {receipt.ownerName && (
                <p className="text-xs text-muted-foreground">{receipt.ownerName}</p>
              )}
              {receipt.propertyAddress && (
                <p className="text-xs text-muted-foreground">{receipt.propertyAddress}</p>
              )}
            </div>
          </div>

          <div className="rounded-lg border border-border overflow-hidden">
            <div className="flex items-center justify-between px-3 py-2 bg-muted/50 text-xs font-semibold uppercase text-muted-foreground border-b border-border">
              <span>Description</span>
              <span>Amount</span>
            </div>
            {receipt.lines.map((line, idx) => (
              <div
                key={`${line.label}-${idx}`}
                className="flex items-center justify-between px-3 py-2.5 border-b border-border/60"
              >
                <span>{line.label}</span>
                <span className="font-semibold">Rs. {formatIndianNumber(line.amount)}</span>
              </div>
            ))}
            <div className="flex items-center justify-between px-3 py-3 bg-muted/30 font-bold">
              <span>Total Paid</span>
              <span className="text-primary text-base">{receipt.totalText}</span>
            </div>
          </div>

          {receipt.totalInWords && (
            <p className="text-xs text-muted-foreground">
              <span className="font-semibold text-foreground">Amount in words:</span>{" "}
              {receipt.totalInWords}
            </p>
          )}

          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-muted/40 p-3 border border-border/60">
            <div className="space-y-0.5 text-xs">
              <p>
                <span className="text-muted-foreground">Method:</span>{" "}
                <span className="font-semibold">{receipt.method}</span>
              </p>
              {receipt.transactionId !== "-" && (
                <p>
                  <span className="text-muted-foreground">Reference:</span>{" "}
                  <span className="font-mono font-semibold">{receipt.transactionId}</span>
                </p>
              )}
            </div>
            <span className="inline-flex items-center gap-1.5 rounded-full bg-success/15 text-success px-3 py-1 text-xs font-semibold">
              <CheckCircle className="w-3.5 h-3.5" />
              {receipt.statusLabel === "Paid" ? "PAYMENT VERIFIED" : receipt.statusLabel}
            </span>
          </div>

          <div className="flex flex-wrap items-center justify-end gap-2 pt-2">
            {!isNative && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="gap-1.5 min-h-[44px] sm:min-h-0"
                onClick={handlePrint}
              >
                <Printer className="w-3.5 h-3.5" />
                Print
              </Button>
            )}
            {onDownloadPdf && (
              <Button
                type="button"
                size="sm"
                className="gap-1.5 gradient-primary min-h-[44px] sm:min-h-0"
                disabled={downloadingPdf}
                onClick={onDownloadPdf}
              >
                <Download className="w-3.5 h-3.5" />
                {downloadingPdf ? "Preparing..." : downloadLabel}
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default RentReceipt;
