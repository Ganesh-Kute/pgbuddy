import { defineConfig, loadEnv, type Plugin } from "vite";
import { rmSync } from "node:fs";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { componentTagger } from "lovable-tagger";
import { VitePWA } from "vite-plugin-pwa";
import { brandIndexHtml, webBrandFromEnv, type WebBrand } from "./src/lib/brands";

// The native (Capacitor) app packs `dist/` into the APK, so anything the phone does not need costs
// every user download size and install time. `vite build --mode native` leaves out:
//  - the website's APK download file (an old APK was being packed inside every new APK),
//  - the social-share image,
//  - the service worker (see `native` below).
const stripFromNativeBuild = (): Plugin => ({
  name: "strip-from-native-build",
  apply: "build",
  closeBundle() {
    for (const file of ["pg-buddy.apk", "og-image.png"]) {
      rmSync(path.resolve(__dirname, "dist", file), { force: true });
    }
  },
});

// Stable vendor chunks: an app change no longer re-downloads React, Supabase and the UI kit.
// Charts are deliberately NOT named here: forcing them into one chunk made the first screen download
// the whole chart library (measured: +107 KB gzip), though only the analytics pages use it.
function vendorChunk(id: string): string | undefined {
  if (!id.includes("node_modules")) return undefined;
  if (/node_modules\/(react|react-dom|react-router|react-router-dom|scheduler)\//.test(id)) return "react";
  if (id.includes("@supabase")) return "supabase";
  if (id.includes("@tanstack")) return "query";
  return undefined;
}

// A white-label website (VITE_IS_WHITE_LABEL=true, e.g. Mauli PG) gets its own name, colour and icon
// on the phone's home screen: in index.html for iPhone ("Add to Home Screen") and in the manifest for
// Android. Without this every brand was installed as "PG Buddy".
const brandHtml = (brand: WebBrand | null): Plugin => ({
  name: "brand-index-html",
  transformIndexHtml: (html) => (brand ? brandIndexHtml(html, brand) : html),
});

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  const native = mode === "native";
  const brand = webBrandFromEnv({ ...loadEnv(mode, process.cwd(), "VITE_"), ...process.env });

  return {
    server: {
      host: "::",
      port: 8080,
      hmr: {
        overlay: false,
      },
    },
    build: {
      rollupOptions: {
        output: { manualChunks: vendorChunk },
      },
    },
    plugins: [
      react(),
      mode === "development" && componentTagger(),
      native && stripFromNativeBuild(),
      brandHtml(brand),
      // The installable-website (PWA) service worker. Not in the native app: the app files are already
      // on the phone, and the worker would copy all of them a second time on first launch.
      !native &&
        VitePWA({
          registerType: "autoUpdate",
          includeAssets: brand
            ? ["favicon.ico", brand.appleTouchIcon.slice(1), brand.icon192.slice(1), brand.icon512.slice(1)]
            : ["favicon.ico", "pwa-icon-192.png", "pwa-icon-512.png"],
          manifest: {
            name: brand ? brand.name : "PG Buddy – PG Management",
            short_name: brand ? brand.name : "PG Buddy",
            description: "Complete PG management platform for property owners and tenants",
            theme_color: brand ? brand.themeColor : "#2563eb",
            background_color: "#ffffff",
            display: "standalone",
            orientation: "portrait",
            scope: "/",
            start_url: "/",
            icons: [
              { src: brand ? brand.icon192 : "/pwa-icon-192.png", sizes: "192x192", type: "image/png" },
              { src: brand ? brand.icon512 : "/pwa-icon-512.png", sizes: "512x512", type: "image/png" },
              {
                src: brand ? brand.icon512 : "/pwa-icon-512.png",
                sizes: "512x512",
                type: "image/png",
                purpose: "maskable",
              },
            ],
          },
          workbox: {
            // Only the app shell. The APK and the big share image are downloads, not app files.
            globPatterns: ["**/*.{js,css,html,ico,svg,woff2}", "pwa-icon-*.png"],
            globIgnores: ["pg-buddy.apk", "og-image.png"],
            navigateFallbackDenylist: [/^\/~oauth/],
            // Push-notification handlers. One worker per scope: a separately registered sw-push.js
            // replaced this worker on every visit (and was replaced by it), see src/main.tsx.
            importScripts: ["sw-push.js"],
            // No API caching: the old rule pointed at a previous Supabase project, so it never matched
            // the live one. Cached API answers would also be per-user data kept on the device.
          },
        }),
    ].filter(Boolean),
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
      },
    },
  };
});
