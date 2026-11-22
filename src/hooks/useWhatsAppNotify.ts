import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";

/** Every action the twilio-notifications edge function accepts. Single source of truth. */
export type WhatsAppAction =
  | "send-rent-reminder"
  | "send-announcement"
  | "send-complaint-alert"
  | "send-vacancy-alert"
  | "send-payment-approval"
  | "send-payment-received"
  | "send-payment-receipt"
  | "send-mess-reminder";

export interface WhatsAppResult {
  sent?: number | boolean;
  total?: number;
  via?: "document" | "template" | "link" | string;
  reason?: string;
  error?: string;
  message?: string;
  statusCode?: number;
}

export interface ReceiptDownloadResult {
  blob?: Blob;
  error?: string;
  statusCode?: number;
}

export interface WhatsAppToastFeedback {
  title: string;
  description?: string;
  variant: "default" | "destructive";
}

async function parseEdgeError(error: unknown): Promise<{ message: string; reason?: string; statusCode?: number }> {
  const errObj = error as { message?: string; context?: Response } | null;
  let message = errObj?.message || "Request failed";
  let reason: string | undefined;
  let statusCode: number | undefined;

  const ctx = errObj?.context;
  if (ctx && typeof ctx === "object") {
    if (typeof ctx.status === "number") {
      statusCode = ctx.status;
    }
    try {
      const text = typeof ctx.text === "function" ? await ctx.text() : "";
      if (text) {
        try {
          const parsed = JSON.parse(text) as { error?: string; reason?: string; message?: string };
          message = parsed.error || parsed.message || parsed.reason || message;
          reason = parsed.reason;
        } catch {
          message = text;
        }
      }
    } catch {
      // Keep fallback error message if response body cannot be read
    }
  }

  return { message, reason, statusCode };
}

function base64ToPdfBlob(base64: string): Blob {
  const clean = base64.includes(",") ? base64.split(",").pop() || "" : base64;
  const bin = atob(clean);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return new Blob([bytes], { type: "application/pdf" });
}

export function formatReceiptWhatsAppFeedback(res: WhatsAppResult | null): WhatsAppToastFeedback {
  const detail = res?.reason || res?.error || res?.message;
  const isNotOnWhatsApp =
    res?.statusCode === 404 ||
    res?.reason === "not_on_whatsapp" ||
    (typeof detail === "string" && /not (?:registered )?on whatsapp|not_on_whatsapp/i.test(detail));

  if (isNotOnWhatsApp) {
    return {
      title: "Not on WhatsApp",
      description: detail || "The tenant's phone number is not registered on WhatsApp.",
      variant: "destructive",
    };
  }

  if (res && Boolean(res.sent)) {
    if (res.via === "document") {
      return {
        title: "PDF sent",
        description: "Receipt PDF delivered on WhatsApp.",
        variant: "default",
      };
    }
    if (res.via === "template") {
      return {
        title: "PDF sent",
        description: "Receipt sent via WhatsApp document template.",
        variant: "default",
      };
    }
    if (res.via === "link") {
      return {
        title: "Link sent (WhatsApp server offline)",
        description: detail || "Delivered receipt link instead of PDF.",
        variant: "default",
      };
    }
    return {
      title: "Receipt sent",
      description: detail || "Receipt sent on WhatsApp.",
      variant: "default",
    };
  }

  return {
    title: "Could not send receipt",
    description: detail || "WhatsApp server unavailable and no fallback succeeded.",
    variant: "destructive",
  };
}

/**
 * Hook to dispatch WhatsApp notifications and download server-rendered receipt PDFs
 * via the twilio-notifications edge function.
 */
export const useWhatsAppNotify = () => {
  const [loading, setLoading] = useState(false);

  const send = async (
    action: WhatsAppAction,
    params: Record<string, unknown>
  ): Promise<WhatsAppResult | null> => {
    setLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke(
        "twilio-notifications",
        { body: { action, ...params } }
      );

      if (error) {
        const parsed = await parseEdgeError(error);
        console.warn("[WhatsApp] Edge function error:", parsed.message);
        return {
          sent: 0,
          error: parsed.message,
          reason: parsed.reason ?? parsed.message,
          statusCode: parsed.statusCode,
        };
      }

      console.log(`[WhatsApp] ${action}:`, data);
      return (data as WhatsAppResult) ?? null;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn("[WhatsApp] Dispatch failed:", message);
      return { sent: 0, error: message, reason: message };
    } finally {
      setLoading(false);
    }
  };

  const downloadReceiptPdf = async (paymentId: string): Promise<ReceiptDownloadResult> => {
    setLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke(
        "twilio-notifications",
        { body: { action: "send-payment-receipt", payment_id: paymentId, mode: "download" } }
      );

      if (error) {
        const parsed = await parseEdgeError(error);
        return { error: parsed.message, statusCode: parsed.statusCode };
      }

      if (data instanceof Blob) {
        if (data.type && data.type.includes("application/json")) {
          try {
            const parsed = JSON.parse(await data.text()) as { error?: string; message?: string };
            return { error: parsed.error || parsed.message || "Failed to generate receipt PDF" };
          } catch {
            // Fall through if not valid JSON
          }
        }
        return { blob: data };
      }

      if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
        const view = data instanceof ArrayBuffer ? data : data.buffer;
        return { blob: new Blob([view], { type: "application/pdf" }) };
      }

      if (data && typeof data === "object" && typeof (data as { pdf_base64?: unknown }).pdf_base64 === "string") {
        return { blob: base64ToPdfBlob((data as { pdf_base64: string }).pdf_base64) };
      }

      return { error: "Unexpected response format while generating PDF" };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    } finally {
      setLoading(false);
    }
  };

  return { send, downloadReceiptPdf, loading };
};
