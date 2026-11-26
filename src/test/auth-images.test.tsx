import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

// /auth is the first screen of the app. Its two decorative photos are shown only on md+ screens, inside
// `hidden md:block` / `hidden md:flex`, but `display: none` does NOT stop a browser from downloading an
// <img src>. Measured on 12e5f90: phones fetched 1.85 MB + 0.39 MB of full-size JPEG they never showed.
// The photos must sit in a <picture> whose <source media="(min-width: 768px)"> holds the real URL, so a
// phone picks the tiny inline fallback and fetches nothing, and the URL must ask for a sized image.

const auth = fs.readFileSync(path.resolve(__dirname, "../pages/Auth.tsx"), "utf8");
const photoUrls = [...auth.matchAll(/https:\/\/images\.unsplash\.com\/[^"'\s)]+/g)].map((m) => m[0]);

describe("/auth decorative photos", () => {
  it("are still there (the test is not vacuous)", () => {
    expect(photoUrls.length).toBeGreaterThanOrEqual(2);
  });

  it("are never an <img src> a phone would download", () => {
    expect(auth).not.toMatch(/<img[^>]*\ssrc=["']https:\/\/images\.unsplash\.com/);
  });

  it("are only offered to md+ screens", () => {
    const sources = [...auth.matchAll(/<source\s[^>]*>/g)].map((m) => m[0]);
    for (const url of photoUrls) {
      const source = sources.find((s) => s.includes(url));
      expect(source, `${url} must be in a <source>`).toBeDefined();
      expect(source).toMatch(/media=["']\(min-width:\s*768px\)["']/);
    }
  });

  it("ask Unsplash for a sized, compressed image, not the multi-megabyte original", () => {
    for (const url of photoUrls) {
      const q = new URL(url.replace(/&amp;/g, "&")).searchParams;
      expect(Number(q.get("w")), url).toBeGreaterThan(0);
      expect(Number(q.get("w")), url).toBeLessThanOrEqual(1600);
      expect(Number(q.get("q")), url).toBeLessThanOrEqual(75);
    }
  });
});
