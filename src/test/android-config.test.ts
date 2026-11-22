import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../..");

function findFiles(dir: string, matcher: (name: string) => boolean): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git" || entry.name === ".gradle" || entry.name === "build") {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...findFiles(full, matcher));
    } else if (entry.isFile() && matcher(entry.name)) {
      out.push(path.relative(ROOT, full).replace(/\\/g, "/"));
    }
  }
  return out;
}

describe("Android build, release signing, and Capacitor startup config (Track P2)", () => {
  it("enables R8 minification, resource shrinking, ABI splits/AAB support, and env-only signing in android/app/build.gradle", () => {
    const gradle = fs.readFileSync(path.join(ROOT, "android", "app", "build.gradle"), "utf8");
    expect(gradle).toContain("minifyEnabled true");
    expect(gradle).toContain("shrinkResources true");
    expect(gradle).toContain("proguard-android-optimize.txt");
    expect(gradle).toContain("ANDROID_KEYSTORE_PATH");
    expect(gradle).toContain("ANDROID_KEYSTORE_PASSWORD");
    expect(gradle).toContain("ANDROID_KEY_ALIAS");
    expect(gradle).toContain("ANDROID_KEY_PASSWORD");
    expect(gradle).toContain("splits {");
    expect(gradle).toContain("arm64-v8a");
    expect(gradle).toContain("armeabi-v7a");
    expect(gradle).toContain("universalApk true");
    expect(gradle).toMatch(/signingConfig\s*=?\s*hasReleaseSigning\s*\?\s*signingConfigs\.release\s*:\s*signingConfigs\.debug/);
  });

  it("never stores Android keystores in git and ignores keystore extensions", () => {
    const keystoreFiles = findFiles(ROOT, (name) => /\.(?:jks|keystore|p12|pfx)$/i.test(name));
    expect(keystoreFiles).toEqual([]);

    const gitignore = fs.readFileSync(path.join(ROOT, "android", ".gitignore"), "utf8");
    expect(gitignore).toMatch(/^\*\.jks$/m);
    expect(gitignore).toMatch(/^\*\.keystore$/m);
  });

  it("hardens Capacitor WebView security and eliminates the artificial 2000ms splash delay", () => {
    const raw = fs.readFileSync(path.join(ROOT, "capacitor.config.json"), "utf8");
    const cfg = JSON.parse(raw) as {
      server?: { androidScheme?: string; allowNavigation?: string[] };
      plugins?: { SplashScreen?: { launchShowDuration?: number; launchAutoHide?: boolean } };
      android?: { allowMixedContent?: boolean };
    };
    expect(cfg.server?.androidScheme).toBe("https");
    expect(cfg.server?.allowNavigation).toContain("*.razorpay.com");
    expect(cfg.android?.allowMixedContent).toBe(false);
    expect(cfg.plugins?.SplashScreen?.launchAutoHide).toBe(true);
    expect(cfg.plugins?.SplashScreen?.launchShowDuration ?? 9999).toBeLessThanOrEqual(300);
  });

  it("hardens AndroidManifest backup policy and splash theme", () => {
    const manifest = fs.readFileSync(path.join(ROOT, "android", "app", "src", "main", "AndroidManifest.xml"), "utf8");
    expect(manifest).toContain("android:allowBackup=\"false\"");

    const styles = fs.readFileSync(path.join(ROOT, "android", "app", "src", "main", "res", "values", "styles.xml"), "utf8");
    expect(styles).toContain("windowSplashScreenBackground");
    expect(styles).toContain("postSplashScreenTheme");

    const colorsPath = path.join(ROOT, "android", "app", "src", "main", "res", "values", "colors.xml");
    expect(fs.existsSync(colorsPath)).toBe(true);
    const colors = fs.readFileSync(colorsPath, "utf8");
    expect(colors).toContain("colorPrimary");
  });

  it("builds signed-capable release APKs and AAB with Java 21 and reports size comparison in build-apk.yml", () => {
    const wf = fs.readFileSync(path.join(ROOT, ".github", "workflows", "build-apk.yml"), "utf8");
    expect(wf).toMatch(/java-version:\s*["']21["']/);
    expect(wf).toContain("assembleRelease");
    expect(wf).toContain("bundleRelease");
    expect(wf).toContain("ANDROID_KEYSTORE_BASE64");
    expect(wf).toContain("secrets.VITE_SUPABASE_URL");
    expect(wf).toContain("secrets.VITE_SUPABASE_PUBLISHABLE_KEY");
    expect(wf).toContain("--mode native");
    expect(wf).toContain("GITHUB_STEP_SUMMARY");
    expect(wf).toContain("signed with the debug key: fine for testing, not for the Play Store");
    expect(wf).not.toContain("unsigned release");
  });
});
