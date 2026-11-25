// @vitest-environment node
// The WhatsApp template definitions must satisfy Meta's rules, or Meta rejects them on creation.
import { describe, expect, it } from "vitest";
import { APP_LINK, DEFAULT_VALUE_MAX, placeholderCount, TEMPLATES, templateCreatePayload, type TemplateDef } from "../../supabase/functions/_shared/whatsapp-templates.ts";

const defs: TemplateDef[] = Object.values(TEMPLATES);

describe("WhatsApp template definitions", () => {
  it("have unique lowercase names", () => {
    const names = defs.map((d) => d.name);
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) expect(n).toMatch(/^[a-z0-9_]{1,512}$/);
  });

  for (const d of defs) {
    describe(d.name, () => {
      const nums = (d.body.match(/\{\{(\d+)\}\}/g) ?? []).map((m) => Number(m.slice(2, -2)));

      it("numbers its placeholders 1..n in order, each once", () => {
        expect(nums).toEqual(nums.map((_, i) => i + 1));
      });

      it("does not start or end with a placeholder, or put two side by side", () => {
        expect(d.body.trimStart()).not.toMatch(/^\{\{/);
        expect(d.body.trimEnd()).not.toMatch(/\}\}[.!?]?$/);
        expect(d.body).not.toMatch(/\}\}\s*\{\{/);
      });

      it("fits Meta's body limit and has one example per placeholder", () => {
        expect(d.body.length).toBeLessThanOrEqual(1024);
        expect(d.example).toHaveLength(placeholderCount(d.body));
        for (const e of d.example) expect(e.trim().length).toBeGreaterThan(0);
      });

      it("stays within the limit when every value is as long as allowed", () => {
        const max = d.valueMax ?? [];
        const longest = nums.reduce((len, n, i) => len - `{{${n}}}`.length + (max[i] ?? DEFAULT_VALUE_MAX), d.body.length);
        expect(longest).toBeLessThanOrEqual(1024);
      });
    });
  }

  it("builds the create request Meta expects, with the button pointing at the app", () => {
    expect(templateCreatePayload(TEMPLATES.tenantWelcome)).toEqual({
      name: "tenant_welcome",
      language: "en",
      category: "UTILITY",
      components: [
        { type: "BODY", text: TEMPLATES.tenantWelcome.body, example: { body_text: [["Rahul", "Sunrise PG", "101"]] } },
        { type: "BUTTONS", buttons: [{ type: "URL", text: "Open PG Buddy", url: APP_LINK }] },
      ],
    });
    expect(templateCreatePayload(TEMPLATES.complaintAlert).components).toHaveLength(1);
  });
});
