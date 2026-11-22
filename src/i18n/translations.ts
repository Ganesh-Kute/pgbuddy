import { en } from "./en";

export type Language = "en" | "hi" | "mr" | "ta" | "te" | "kn" | "ml" | "bn" | "gu" | "pa" | "or" | "as";

export const SUPPORTED_LANGUAGES: readonly Language[] = [
  "en",
  "hi",
  "mr",
  "ta",
  "te",
  "kn",
  "ml",
  "bn",
  "gu",
  "pa",
  "or",
  "as",
];

export { en };

const localeLoaders: Record<Exclude<Language, "en">, () => Promise<{ default: Record<string, string> }>> = {
  hi: () => import("./locales/hi"),
  mr: () => import("./locales/mr"),
  ta: () => import("./locales/ta"),
  te: () => import("./locales/te"),
  kn: () => import("./locales/kn"),
  ml: () => import("./locales/ml"),
  bn: () => import("./locales/bn"),
  gu: () => import("./locales/gu"),
  pa: () => import("./locales/pa"),
  or: () => import("./locales/or"),
  as: () => import("./locales/as"),
};

const localeCache: Partial<Record<Language, Record<string, string>>> = { en };

export function getCachedLanguage(lang: Language): Record<string, string> | undefined {
  return localeCache[lang];
}

export async function loadLanguage(lang: Language): Promise<Record<string, string>> {
  const cached = localeCache[lang];
  if (cached) return cached;
  if (lang === "en") return en;
  const loader = localeLoaders[lang];
  if (!loader) return en;
  const mod = await loader();
  localeCache[lang] = mod.default;
  return mod.default;
}
