/**
 * Centralized branding logic for White-Labeling the PG Software.
 * This reads from Vite environment variables to dynamically replace "PG Buddy"
 * with a client's custom name and logo.
 */

export const isWhiteLabel = import.meta.env.VITE_IS_WHITE_LABEL === "true";

export const getAppName = (): string => {
  return isWhiteLabel && import.meta.env.VITE_APP_NAME 
    ? import.meta.env.VITE_APP_NAME 
    : "PG Buddy";
};

export const getAppLogo = (): string => {
  // If white labeled, we assume custom-logo.png is placed in the public folder
  return isWhiteLabel ? "/custom-logo.png" : "/pwa-icon-192.png";
};

/** Colour theme for a white-label build ("mauli"), or "" for the PG Buddy colours. */
export const brandTheme: string = (import.meta.env.VITE_BRAND_THEME ?? "").trim().toLowerCase();

const BRAND_COLORS: Record<string, { primary: string; dark: string }> = {
  "": { primary: "#7c3aed", dark: "#0d0a16" },
  mauli: { primary: "#0a4a9a", dark: "#060e1f" },
};

/** Hex colours for places CSS variables cannot reach (browser bar, printed receipt). */
export const getBrandColors = () => BRAND_COLORS[brandTheme] ?? BRAND_COLORS[""];

/** Switch on the theme's CSS (html.theme-<name> in index.css). */
export function applyBrandTheme(root: HTMLElement = document.documentElement): void {
  if (brandTheme && /^[a-z0-9-]+$/.test(brandTheme)) root.classList.add(`theme-${brandTheme}`);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta && brandTheme) meta.setAttribute("content", getBrandColors().primary);
}
