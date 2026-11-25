// Brand data shared by the app (src/lib/branding.ts) and the build (vite.config.ts).
// Plain data and pure functions only: vite.config.ts runs in Node, where import.meta.env does not exist.

export const BRAND_COLORS: Record<string, { primary: string; dark: string }> = {
  "": { primary: "#7c3aed", dark: "#0d0a16" },
  mauli: { primary: "#0a4a9a", dark: "#060e1f" },
};

/** What a phone shows when the website is added to the home screen (iPhone) or installed (Android). */
export type WebBrand = {
  name: string;
  themeColor: string;
  /** 180×180, no transparency: iOS turns transparent pixels black. */
  appleTouchIcon: string;
  icon192: string;
  icon512: string;
};

/** The home-screen identity of a white-label build, or null for PG Buddy (index.html and the manifest as written). */
export function webBrandFromEnv(env: Record<string, string | undefined>): WebBrand | null {
  if (env.VITE_IS_WHITE_LABEL !== "true") return null;
  const name = env.VITE_APP_NAME?.trim();
  const theme = (env.VITE_BRAND_THEME ?? "").trim().toLowerCase();
  if (!name || !/^[a-z0-9-]+$/.test(theme) || !BRAND_COLORS[theme]) return null;
  return {
    name,
    themeColor: BRAND_COLORS[theme].primary,
    appleTouchIcon: `/brand/${theme}/apple-touch-icon.png`,
    icon192: `/brand/${theme}/icon-192.png`,
    icon512: `/brand/${theme}/icon-512.png`,
  };
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Puts the brand's name, colour and icon into index.html (title, iOS home-screen title and icon, browser bar). */
export function brandIndexHtml(html: string, brand: WebBrand): string {
  const name = escapeHtml(brand.name);
  return html
    .replace(/<title>[^<]*<\/title>/, `<title>${name}</title>`)
    .replace(/(<meta name="apple-mobile-web-app-title" content=")[^"]*/, `$1${name}`)
    .replace(/(<meta name="application-name" content=")[^"]*/, `$1${name}`)
    .replace(/(<meta name="theme-color" content=")[^"]*/, `$1${brand.themeColor}`)
    .replace(/(<link rel="apple-touch-icon" href=")[^"]*/, `$1${brand.appleTouchIcon}`);
}
