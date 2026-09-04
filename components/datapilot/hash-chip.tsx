'use client';

import { Check } from 'lucide-react';

import { useCopy } from '@/components/datapilot/copy-button';
import { shortHash } from '@/lib/format';
import { useLanguage } from '@/lib/language';
import { cn } from '@/lib/utils';

export type HashChipProps = {
  value: string | null | undefined;
  label?: string;
  length?: number;
  className?: string;
};

/** First `length` characters of a hash; click copies the full value; title shows it in full. */
export function HashChip({ value, label, length = 10, className }: HashChipProps) {
  const { t } = useLanguage();
  const [copied, copy] = useCopy();
  if (!value) {
    return (
      <span className={cn('inline-flex items-center gap-1 text-xs text-muted-foreground', className)}>
        {label ? <span>{label}</span> : null}
        <span className="mono">—</span>
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={() => void copy(value)}
      title={`${value}\n${t('Click to copy', '点击复制')}`}
      aria-label={`${label ? `${label} ` : ''}${value}`}
      className={cn(
        'inline-flex h-6 max-w-full items-center gap-1.5 rounded-md border border-border bg-card px-1.5 text-xs transition-colors hover:bg-muted',
        className,
      )}
    >
      {label ? <span className="text-muted-foreground">{label}</span> : null}
      <span className="mono text-foreground">{shortHash(value, length)}</span>
      {copied ? (
        <span className="inline-flex items-center gap-0.5 text-policy">
          <Check aria-hidden="true" className="size-3" />
          <span className="text-[11px]">{t('Copied', '已复制')}</span>
        </span>
      ) : null}
    </button>
  );
}
