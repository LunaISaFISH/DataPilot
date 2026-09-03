'use client';

import { Languages } from 'lucide-react';

import { useLanguage } from '@/lib/language';

export function LanguageToggle() {
  const { language, toggleLanguage } = useLanguage();
  const next = language === 'en' ? '中文' : 'EN';
  return (
    <button
      type="button"
      onClick={toggleLanguage}
      className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-border bg-card px-3 text-sm font-semibold transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/40"
      aria-label={language === 'en' ? '切换到中文' : 'Switch to English'}
    >
      <Languages aria-hidden="true" className="size-4" />
      {next}
    </button>
  );
}
