'use client';

import { Check, Copy } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { useLanguage } from '@/lib/language';
import { cn } from '@/lib/utils';

/** Copies via the async clipboard API; returns false when unavailable (insecure context, denied). */
export async function copyText(value: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // clipboard unavailable
  }
  return false;
}

/** Returns [copied, trigger]; `copied` resets after `resetMs`. */
export function useCopy(resetMs = 1500): [boolean, (value: string) => Promise<void>] {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const trigger = async (value: string) => {
    const ok = await copyText(value);
    setCopied(ok);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), resetMs);
  };
  return [copied, trigger];
}

export type CopyButtonProps = {
  value: string;
  label?: string;
  className?: string;
  size?: 'sm' | 'md';
};

export function CopyButton({ value, label: customLabel, className, size = 'sm' }: CopyButtonProps) {
  const { t } = useLanguage();
  const [copied, copy] = useCopy();
  const text = copied ? t('Copied', '已复制') : (customLabel ?? t('Copy', '复制'));
  return (
    <button
      type="button"
      onClick={() => void copy(value)}
      aria-label={text}
      title={text}
      className={cn(
        'inline-flex items-center gap-1 rounded-md border border-border bg-card text-muted-foreground transition-colors hover:bg-muted hover:text-foreground',
        size === 'sm' ? 'h-6 px-1.5 text-[11px]' : 'h-7 px-2 text-xs',
        className,
      )}
    >
      {copied ? <Check aria-hidden="true" className="size-3" /> : <Copy aria-hidden="true" className="size-3" />}
      {customLabel !== undefined || copied ? <span>{text}</span> : null}
    </button>
  );
}
