// Every WhatsApp template PG Buddy sends through Meta's Cloud API, in one place.
//
// The same definitions are used to create the templates on Meta (scripts/create-whatsapp-templates.ts)
// and to send them (whatsapp-cloud.ts), and a test checks the two agree, so the text Meta approved
// and the values the code fills in cannot drift apart.
//
// Meta's rules for the body (checked in src/test/whatsapp-templates.test.ts):
//   placeholders are {{1}}..{{n}} in order; the body may not start or end with one, two may not be
//   next to each other, and the body is at most 1024 characters.
//
// login_otp (AUTHENTICATION) is not here: Meta fixes its text ("{{1}} is your verification code").
// payment_receipt has a DOCUMENT header and is built in whatsapp-cloud.ts; its body is listed so the
// placeholder count is still checked.

export type TemplateDef = {
  name: string;
  category: "UTILITY";
  language: "en";
  body: string;
  /** One sample value per placeholder, sent to Meta for review. */
  example: string[];
  /** Longest text allowed per value (default DEFAULT_VALUE_MAX); a longer value is cut. */
  valueMax?: readonly number[];
  /** Optional static link button (no variable part). */
  urlButton?: { text: string; url: string };
  /** Created by hand before this file existed (already approved on Meta). */
  preexisting?: true;
};

export const APP_LINK = "https://pgbuddy.getgrm.tech";

/** Longest text per value unless a template says otherwise: keeps even a 5-value body under 1024. */
export const DEFAULT_VALUE_MAX = 150;

const IGNORE_IF_PAID = "If you have already paid, please ignore this message.";

export const TEMPLATES = {
  paymentReceipt: {
    name: "payment_receipt",
    category: "UTILITY",
    language: "en",
    body: "Hi {{1}}, we have received your payment of Rs. {{2}} for {{3}} at {{4}}. Your receipt is attached. Thank you!",
    example: ["Rahul", "8,500", "Nov 2026", "Sunrise PG"],
    preexisting: true,
  },
  rentReminder: {
    name: "rent_reminder",
    category: "UTILITY",
    language: "en",
    body: "Hi {{1}}, this is a reminder that your rent of Rs. {{2}} for {{3}} at {{4}} is due on {{5}}. Please pay by the due date. Thank you!",
    example: ["Rahul", "8,500", "Nov 2026", "Sunrise PG", "5 Nov 2026"],
    preexisting: true,
  },
  rentOverdue: {
    name: "rent_overdue",
    category: "UTILITY",
    language: "en",
    body:
      "Hi {{1}}, your rent of ₹{{2}} for {{3}} at {{4}} was due on {{5}} and is still pending. " +
      `Please pay as soon as possible. ${IGNORE_IF_PAID}`,
    example: ["Rahul", "8,500", "Nov 2026", "Sunrise PG", "5 Nov 2026"],
  },
  messBillReminder: {
    name: "mess_bill_reminder",
    category: "UTILITY",
    language: "en",
    body:
      "Hi {{1}}, this is a reminder that your mess bill of ₹{{2}} for {{3}} at {{4}} is pending. " +
      `Please pay at your earliest convenience. ${IGNORE_IF_PAID}`,
    example: ["Rahul", "3,200", "Nov 2026", "Sunrise Mess"],
  },
  tenantWelcome: {
    name: "tenant_welcome",
    category: "UTILITY",
    language: "en",
    body:
      "Hi {{1}}, welcome to {{2}}! You have been added to room {{3}}. " +
      "In the PG Buddy app you can pay rent, download receipts and raise complaints.",
    example: ["Rahul", "Sunrise PG", "101"],
    urlButton: { text: "Open PG Buddy", url: APP_LINK },
  },
  pgNotice: {
    name: "pg_notice",
    category: "UTILITY",
    language: "en",
    body: "Hello, there is a new notice from {{1}} for residents.\n\n*{{2}}*\n{{3}}\n\nYou can also read it in the PG Buddy app.",
    example: ["Sunrise PG", "Water supply", "Water will be off on Sunday from 10 am to 1 pm for tank cleaning."],
    valueMax: [100, 120, 700],
  },
  complaintAlert: {
    name: "complaint_alert",
    category: "UTILITY",
    language: "en",
    body:
      "A complaint has been logged at {{1}}.\n\nTenant: {{2}}\nRoom: {{3}}\nCategory: {{4}}\nIssue: {{5}}\n\n" +
      "The PG staff have been notified and will look into it.",
    example: ["Sunrise PG", "Rahul", "101", "Plumbing", "Bathroom tap is leaking"],
  },
  vacancyAlert: {
    name: "vacancy_alert",
    category: "UTILITY",
    language: "en",
    body:
      "Move-out notice at {{1}}: tenant {{2}} plans to move out on {{3}}. " +
      "The room will be free after that date. Details are in the PG Buddy app.",
    example: ["Sunrise PG", "Rahul", "30 Nov 2026"],
  },
  paymentProofSubmitted: {
    name: "payment_proof_submitted",
    category: "UTILITY",
    language: "en",
    body:
      "A rent payment was submitted at {{1}} and is waiting for your approval.\n\n" +
      "Tenant: {{2}}\nRoom: {{3}}\nAmount: ₹{{4}}\nFor: {{5}}\n\nPlease review it in the PG Buddy app.",
    example: ["Sunrise PG", "Rahul", "101", "8,500", "Nov 2026"],
  },
} as const satisfies Record<string, TemplateDef>;

export type TemplateKey = keyof typeof TEMPLATES;

/** Number of {{n}} placeholders in a body. */
export function placeholderCount(body: string): number {
  return new Set(body.match(/\{\{\d+\}\}/g) ?? []).size;
}

/** The request body for POST /{waba-id}/message_templates. */
export function templateCreatePayload(def: TemplateDef): Record<string, unknown> {
  const components: unknown[] = [{ type: "BODY", text: def.body, example: { body_text: [def.example] } }];
  if (def.urlButton) {
    components.push({ type: "BUTTONS", buttons: [{ type: "URL", text: def.urlButton.text, url: def.urlButton.url }] });
  }
  return { name: def.name, language: def.language, category: def.category, components };
}
