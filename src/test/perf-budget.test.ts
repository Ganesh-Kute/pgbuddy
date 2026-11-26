import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

// What a page downloads before it can paint is decided by its STATIC imports: Vite puts everything a page
// imports at the top of a file into that page's first load, and only `import()` is split off.
// This walks those static imports from a page, the same way the bundler does, and lists the packages reached.

const SRC = path.resolve(__dirname, "..");
const EXTS = [".tsx", ".ts", "/index.tsx", "/index.ts"];

/** Static imports only: `import x from "y"`, `import "y"`, `export ... from "y"`. Type-only imports are skipped. */
function staticImports(code: string): string[] {
  const out: string[] = [];
  const re = /^\s*(?:import|export)\s+(?!type\s)(?:[^'"]*?\sfrom\s+)?["']([^"']+)["']/gm;
  for (const m of code.matchAll(re)) out.push(m[1]);
  return out;
}

function resolveLocal(spec: string, fromFile: string): string | null {
  const base = spec.startsWith("@/") ? path.join(SRC, spec.slice(2)) : path.resolve(path.dirname(fromFile), spec);
  if (fs.existsSync(base) && fs.statSync(base).isFile()) return base;
  for (const ext of EXTS) if (fs.existsSync(base + ext)) return base + ext;
  return null;
}

/** Every npm package reached through static imports from `entry` (relative to src/). */
export function packagesOnFirstLoad(entry: string): Set<string> {
  const pkgs = new Set<string>();
  const seen = new Set<string>();
  const stack = [path.join(SRC, entry)];
  while (stack.length) {
    const file = stack.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of staticImports(fs.readFileSync(file, "utf8"))) {
      if (spec.startsWith(".") || spec.startsWith("@/")) {
        const next = resolveLocal(spec, file);
        if (next && /\.(tsx?|jsx?)$/.test(next)) stack.push(next);
      } else {
        pkgs.add(spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]);
      }
    }
  }
  return pkgs;
}

describe("first-load weight of the pages people open first", () => {
  it("the owner dashboard does not download the chart library before it paints (116 KB gzip)", () => {
    expect(packagesOnFirstLoad("pages/Dashboard.tsx").has("recharts")).toBe(false);
  });

  // Auth.tsx joins this list once T1 releases it (it still uses framer-motion today).
  it.each(["pages/TenantDashboard.tsx", "pages/Dashboard.tsx"])(
    "%s does not pull the full framer-motion bundle onto its first load",
    (page) => {
      expect(packagesOnFirstLoad(page).has("framer-motion")).toBe(false);
    },
  );

  it("the walker itself finds static imports (guards the test against passing vacuously)", () => {
    const pkgs = packagesOnFirstLoad("pages/Dashboard.tsx");
    expect(pkgs.has("react")).toBe(true);
    expect(pkgs.has("@supabase/supabase-js")).toBe(true);
  });
});
