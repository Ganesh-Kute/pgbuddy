// @vitest-environment node
import { describe, expect, it } from "vitest";
import { cloudConfigFromEnv, templateText, toWaId } from "../../supabase/functions/_shared/whatsapp-cloud.ts";

describe("WhatsApp Cloud API helpers", () => {
  it("is only enabled when both the token and a numeric phone number id are set", () => {
    const env = (vars: Record<string, string>) => (n: string) => vars[n];
    expect(cloudConfigFromEnv(env({ WHATSAPP_TOKEN: "EAA", WHATSAPP_PHONE_NUMBER_ID: "1553178531205507" }))).toEqual({ token: "EAA", phoneNumberId: "1553178531205507" });
    expect(cloudConfigFromEnv(env({ WHATSAPP_TOKEN: "EAA" }))).toBeNull();
    expect(cloudConfigFromEnv(env({ WHATSAPP_PHONE_NUMBER_ID: "1553178531205507" }))).toBeNull();
    expect(cloudConfigFromEnv(env({ WHATSAPP_TOKEN: "EAA", WHATSAPP_PHONE_NUMBER_ID: "../me" }))).toBeNull();
  });

  it("formats Indian numbers for the API", () => {
    expect(toWaId("9876543210")).toBe("919876543210");
    expect(toWaId("+91 98765 43210")).toBe("919876543210");
    expect(toWaId("919876543210")).toBe("919876543210");
    expect(toWaId("12345")).toBeNull();
  });

  it("cleans template values the way Meta requires (no newlines, tabs or long space runs)", () => {
    expect(templateText("Sunrise\\nPG")).toBe("Sunrise\\nPG");
    expect(templateText("Sunrise\nPG\t2")).toBe("Sunrise PG 2");
    expect(templateText("a      b")).toBe("a   b");
    expect(templateText("   ")).toBe("-");
    expect(templateText("x".repeat(500)).length).toBe(200);
  });
});
