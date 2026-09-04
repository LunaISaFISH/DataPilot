'use client';

import { Languages } from 'lucide-react';

import { useLanguage } from '@/lib/language';
import { cn } from '@/lib/utils';

export function LanguageToggle({ className }: { className?: string }) {
  const { language, toggleLanguage } = useLanguage();
  const next = language === 'en' ? '中文' : 'EN';
  return (
    <button
      type="button"
      onClick={toggleLanguage}
      className={cn(
        'inline-flex h-7 items-center gap-1.5 rounded-md border border-border bg-card px-2 text-xs font-semibold transition-colors hover:bg-muted',
        className,
      )}
      aria-label={language === 'en' ? '切换到中文' : 'Switch to English'}
      title={language === 'en' ? '切换到中文' : 'Switch to English'}
    >
      <Languages aria-hidden="true" className="size-3.5" />
      {next}
    </button>
  );
}
