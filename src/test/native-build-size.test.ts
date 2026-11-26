// @vitest-environment node
// The APK packs dist/ into its assets. The website's own APK downloads live in public/, so a native
// build must leave them out, or every new APK carries the previous one inside (found 26 Nov 2026:
// the Mauli APK held a 2.9 MB older APK at assets/public/downloads/mauli-pg.apk).
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../..");

/** Every .apk/.aab under public/, as paths relative to public/ (what lands in dist/). */
function packagesInPublic(dir = path.join(ROOT, "public"), rel = ""): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...packagesInPublic(path.join(dir, e.name), r));
    else if (/\.(apk|aab)$/i.test(e.name)) out.push(r);
  }
  return out;
}

describe("native (APK) build", () => {
  it("leaves out every APK the website offers for download", async () => {
    const { NATIVE_BUILD_STRIP } = await import("../../vite.config");
    const stripped = (p: string) => NATIVE_BUILD_STRIP.some((s) => p === s || p.startsWith(`${s}/`));
    const leaking = packagesInPublic().filter((p) => !stripped(p));
    expect(leaking).toEqual([]);
  });
});
