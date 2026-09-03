'use client';

import { createContext, useContext, useEffect, useMemo, useSyncExternalStore } from 'react';

type Language = 'en' | 'zh';

type LanguageContextValue = {
  language: Language;
  toggleLanguage: () => void;
  t: (english: string, chinese: string) => string;
};

const STORAGE_KEY = 'datapilot-language';
const LANGUAGE_EVENT = 'datapilot-language-change';
const LanguageContext = createContext<LanguageContextValue | null>(null);

function subscribe(onStoreChange: () => void) {
  window.addEventListener('storage', onStoreChange);
  window.addEventListener(LANGUAGE_EVENT, onStoreChange);
  return () => {
    window.removeEventListener('storage', onStoreChange);
    window.removeEventListener(LANGUAGE_EVENT, onStoreChange);
  };
}

function getSnapshot(): Language {
  return window.localStorage.getItem(STORAGE_KEY) === 'zh' ? 'zh' : 'en';
}

function getServerSnapshot(): Language {
  return 'en';
}

export function LanguageProvider({ children }: { children: React.ReactNode }) {
  const language = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  useEffect(() => {
    document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en';
  }, [language]);

  const value = useMemo<LanguageContextValue>(
    () => ({
      language,
      toggleLanguage: () => {
        window.localStorage.setItem(STORAGE_KEY, language === 'en' ? 'zh' : 'en');
        window.dispatchEvent(new Event(LANGUAGE_EVENT));
      },
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
