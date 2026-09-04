'use client';

import { EyeOff } from 'lucide-react';

import { useLanguage } from '@/lib/language';
import { cn } from '@/lib/utils';

export type MaskedValueProps = {
  value: string | null | undefined;
  patternClass?: string | null;
  /** Force the masked treatment even when the value has no mask glyphs. */
  masked?: boolean;
  className?: string;
};

const MASK_GLYPHS = /[•*]{2,}/;

/** Renders a cell value; masked values (engine masks or `masked`) get a lock glyph and pattern class. */
export function MaskedValue({ value, patternClass, masked, className }: MaskedValueProps) {
  const { t } = useLanguage();
  const isMasked = masked ?? (typeof value === 'string' && MASK_GLYPHS.test(value));
  if (value === null || value === undefined || value === '') {
    return <span className={cn('mono text-muted-foreground', className)}>∅</span>;
  }
  if (!isMasked) return <span className={cn('mono', className)}>{value}</span>;
  return (
    <span
      className={cn('mono inline-flex items-center gap-1 text-muted-foreground', className)}
      title={t('Sensitive value withheld', '敏感值已屏蔽')}
    >
      <EyeOff aria-hidden="true" className="size-3 shrink-0" />
      <span>{value}</span>
      {patternClass ? <span className="pill pill-neutral">{patternClass}</span> : null}
    </span>
  );
}
