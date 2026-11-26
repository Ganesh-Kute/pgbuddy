import { defineConfig, type Plugin } from "vite";
import { rmSync } from "node:fs";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { componentTagger } from "lovable-tagger";
import { VitePWA } from "vite-plugin-pwa";

// The native (Capacitor) app packs `dist/` into the APK, so anything the phone does not need costs
// every user download size and install time. `vite build --mode native` leaves out:
//  - the website's APK download files, pg-buddy.apk and the whole downloads/ folder (an old APK was
//    being packed inside every new APK: the 26 Nov 2026 Mauli APK carried a 2.9 MB older APK in
//    assets/public/downloads/, and each build would have nested the previous one again),
//  - the social-share image,
//  - the service worker (see `native` below).
export const NATIVE_BUILD_STRIP = ["pg-buddy.apk", "og-image.png", "downloads"] as const;

const stripFromNativeBuild = (): Plugin => ({
  name: "strip-from-native-build",
  apply: "build",
  closeBundle() {
    for (const entry of NATIVE_BUILD_STRIP) {
      rmSync(path.resolve(__dirname, "dist", entry), { force: true, recursive: true });
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

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  const native = mode === "native";

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
      // The installable-website (PWA) service worker. Not in the native app: the app files are already
      // on the phone, and the worker would copy all of them a second time on first launch.
      !native &&
        VitePWA({
          registerType: "autoUpdate",
          includeAssets: ["favicon.ico", "pwa-icon-192.png", "pwa-icon-512.png"],
          manifest: {
            name: "PG Buddy – PG Management",
            short_name: "PG Buddy",
            description: "Complete PG management platform for property owners and tenants",
            theme_color: "#2563eb",
            background_color: "#ffffff",
            display: "standalone",
            orientation: "portrait",
            scope: "/",
            start_url: "/",
            icons: [
              { src: "/pwa-icon-192.png", sizes: "192x192", type: "image/png" },
              { src: "/pwa-icon-512.png", sizes: "512x512", type: "image/png" },
              { src: "/pwa-icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
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
