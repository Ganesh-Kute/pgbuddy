import { createContext, useContext, useState, useCallback, useEffect, ReactNode } from "react";
import { Language, SUPPORTED_LANGUAGES, en, getCachedLanguage, loadLanguage } from "./translations";

interface LanguageContextType {
  language: Language;
  setLanguage: (lang: Language) => void;
  t: (key: string) => string;
  isLoadingLocale: boolean;
}

const LanguageContext = createContext<LanguageContextType | undefined>(undefined);

function resolveInitialLanguage(): Language {
  try {
    const stored = localStorage.getItem("pg-lang") as Language | null;
    if (stored && SUPPORTED_LANGUAGES.includes(stored)) {
      return stored;
    }
  } catch {
    // ignore storage errors in restricted contexts
  }
  return "en";
}

export const LanguageProvider = ({ children }: { children: ReactNode }) => {
  const [language, setLanguageState] = useState<Language>(resolveInitialLanguage);
  const [dict, setDict] = useState<Record<string, string>>(() => getCachedLanguage(resolveInitialLanguage()) ?? en);
  const [isLoadingLocale, setIsLoadingLocale] = useState<boolean>(() => {
    const initial = resolveInitialLanguage();
    return initial !== "en" && !getCachedLanguage(initial);
  });

  useEffect(() => {
    if (language === "en") {
      setDict(en);
      setIsLoadingLocale(false);
      return;
    }

    const cached = getCachedLanguage(language);
    if (cached) {
      setDict(cached);
      setIsLoadingLocale(false);
      return;
    }

    let cancelled = false;
    setIsLoadingLocale(true);
    loadLanguage(language)
      .then((loaded) => {
        if (!cancelled) {
          setDict(loaded);
          setIsLoadingLocale(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setDict(en);
          setIsLoadingLocale(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [language]);

  const setLanguage = useCallback((lang: Language) => {
    setLanguageState(lang);
    try {
      localStorage.setItem("pg-lang", lang);
    } catch {
      // ignore storage errors
    }
  }, []);

  const t = useCallback(
    (key: string) => dict[key] || en[key] || key,
    [dict],
  );

  return (
    <LanguageContext.Provider value={{ language, setLanguage, t, isLoadingLocale }}>
      {children}
    </LanguageContext.Provider>
  );
};

const fallbackT = (key: string) => en[key] || key;

const defaultContext: LanguageContextType = {
  language: "en",
  setLanguage: () => {},
  t: fallbackT,
  isLoadingLocale: false,
};

export const useLanguage = () => {
  const ctx = useContext(LanguageContext);
  return ctx ?? defaultContext;
};
