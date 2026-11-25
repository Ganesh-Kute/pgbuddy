// A white-label website (Mauli PG) must be added to an iPhone home screen as "Mauli PG" with its own
// icon, not as "PG Buddy". iOS reads the name and icon from index.html (apple-mobile-web-app-title,
// apple-touch-icon); Android reads the manifest. Both come from these helpers (see vite.config.ts).
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { brandIndexHtml, webBrandFromEnv } from "@/lib/brands";
import { DEFAULT_ALLOWED_ORIGINS } from "../../supabase/functions/_shared/security";

const ROOT = path.resolve(__dirname, "../..");
const INDEX_HTML = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const MAULI = { VITE_IS_WHITE_LABEL: "true", VITE_APP_NAME: "Mauli PG", VITE_BRAND_THEME: "mauli" };

describe("webBrandFromEnv", () => {
  it("gives Mauli PG its name, blue and icons", () => {
    expect(webBrandFromEnv(MAULI)).toEqual({
      name: "Mauli PG",
      themeColor: "#0a4a9a",
      appleTouchIcon: "/brand/mauli/apple-touch-icon.png",
      icon192: "/brand/mauli/icon-192.png",
      icon512: "/brand/mauli/icon-512.png",
    });
  });

  it("leaves the PG Buddy website as it is", () => {
    expect(webBrandFromEnv({})).toBeNull();
    expect(webBrandFromEnv({ ...MAULI, VITE_IS_WHITE_LABEL: "false" })).toBeNull();
  });

  it("refuses an unknown theme or a theme name that could escape the icon folder", () => {
    expect(webBrandFromEnv({ ...MAULI, VITE_BRAND_THEME: "nope" })).toBeNull();
    expect(webBrandFromEnv({ ...MAULI, VITE_BRAND_THEME: "../x" })).toBeNull();
    expect(webBrandFromEnv({ ...MAULI, VITE_APP_NAME: " " })).toBeNull();
  });

  it("every icon it names exists, and the iPhone icon has no transparency (iOS paints it black)", () => {
    const brand = webBrandFromEnv(MAULI)!;
    for (const icon of [brand.appleTouchIcon, brand.icon192, brand.icon512]) {
      const png = fs.readFileSync(path.join(ROOT, "public", icon));
      expect(png.subarray(1, 4).toString()).toBe("PNG");
    }
    const touch = fs.readFileSync(path.join(ROOT, "public", brand.appleTouchIcon));
    expect(touch.readUInt32BE(16)).toBe(180); // width
    expect(touch.readUInt32BE(20)).toBe(180); // height
    expect(touch[25]).toBe(2); // PNG colour type 2 = RGB, no alpha channel
  });
});

describe("brandIndexHtml", () => {
  const html = brandIndexHtml(INDEX_HTML, webBrandFromEnv(MAULI)!);

  it("sets what iOS uses for 'Add to Home Screen' and the browser bar colour", () => {
    expect(html).toContain('<meta name="apple-mobile-web-app-title" content="Mauli PG"');
    expect(html).toContain('<link rel="apple-touch-icon" href="/brand/mauli/apple-touch-icon.png"');
    expect(html).toContain('<meta name="theme-color" content="#0a4a9a"');
    expect(html).toContain("<title>Mauli PG</title>");
    expect(html).not.toMatch(/apple-mobile-web-app-title" content="PG Buddy"/);
  });

  it("keeps the tags an installed iPhone web app needs", () => {
    expect(html).toContain('<meta name="apple-mobile-web-app-capable" content="yes"');
    expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest"');
  });

  it("escapes the name", () => {
    const out = brandIndexHtml(INDEX_HTML, { ...webBrandFromEnv(MAULI)!, name: 'A "B" <C>' });
    expect(out).toContain("<title>A &quot;B&quot; &lt;C&gt;</title>");
  });
});

describe("backend", () => {
  it("accepts calls from the Mauli PG web address (receipts, WhatsApp alerts)", () => {
    expect(DEFAULT_ALLOWED_ORIGINS).toContain("https://mauli.getgrm.tech");
  });
});
