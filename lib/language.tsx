'use client';

import { createContext, useContext, useEffect, useMemo, useSyncExternalStore } from 'react';

export type Language = 'en' | 'zh';

type LanguageContextValue = {
  language: Language;
  toggleLanguage: () => void;
  setLanguage: (language: Language) => void;
  t: (english: string, chinese: string) => string;
};

const STORAGE_KEY = 'datapilot-language';
const LANGUAGE_EVENT = 'datapilot-language-change';
const DEFAULT_LANGUAGE: Language = 'zh';
const LanguageContext = createContext<LanguageContextValue | null>(null);

function subscribe(onStoreChange: () => void) {
  window.addEventListener('storage', onStoreChange);
  window.addEventListener(LANGUAGE_EVENT, onStoreChange);
  return () => {
    window.removeEventListener('storage', onStoreChange);
    window.removeEventListener(LANGUAGE_EVENT, onStoreChange);
  };
}

function readStored(): Language {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === 'en' || stored === 'zh') return stored;
  } catch {
    // localStorage unavailable (private mode, blocked storage) → default
  }
  return DEFAULT_LANGUAGE;
}

function getServerSnapshot(): Language {
  return DEFAULT_LANGUAGE;
}

function writeStored(language: Language) {
  try {
    window.localStorage.setItem(STORAGE_KEY, language);
  } catch {
    // ignore; the event below still updates the current tab
  }
  window.dispatchEvent(new Event(LANGUAGE_EVENT));
}

export function LanguageProvider({ children }: { children: React.ReactNode }) {
  const language = useSyncExternalStore(subscribe, readStored, getServerSnapshot);

  useEffect(() => {
    document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en';
  }, [language]);

  const value = useMemo<LanguageContextValue>(
    () => ({
      language,
      toggleLanguage: () => writeStored(language === 'en' ? 'zh' : 'en'),
      setLanguage: writeStored,
      t: (english, chinese) => (language === 'zh' ? chinese : english),
    }),
    [language],
  );

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export function useLanguage() {
  const value = useContext(LanguageContext);
  if (!value) throw new Error('useLanguage must be used inside LanguageProvider');
  return value;
}

/** Pick the `*_zh` / `*_en` variant of an API-provided pair. */
export function pick(language: Language, zh: string | null | undefined, en: string | null | undefined): string {
  const primary = language === 'zh' ? zh : en;
  const secondary = language === 'zh' ? en : zh;
  return primary || secondary || '';
}
