'use client';

import type { CSSProperties } from 'react';

import { HashChip } from '@/components/datapilot';
import { useLanguage } from '@/lib/language';
import { cn } from '@/lib/utils';

// Equality underline for hashes (spec §9.1): identical digests on the same screen get the same
// coloured 2px underline, so equality is visible from a distance. The hue is derived from the
// digest itself, which makes the mapping stable across panes without shared state.

const UNDERLINE_SATURATION = 62;
const UNDERLINE_LIGHTNESS = 42;

/** Deterministic hue (0–359) for a digest: identical inputs → identical colour. */
export function hashHue(value: string): number {
  let h = 0;
  for (let i = 0; i < value.length; i += 1) h = (h * 31 + value.charCodeAt(i)) >>> 0;
  return h % 360;
}

/** 2px bottom border in the digest's colour; applied to a wrapper so the chip's own background never hides it. */
export function underlineStyle(value: string | null | undefined): CSSProperties | undefined {
  if (!value) return undefined;
  return { borderBottom: `2px solid hsl(${hashHue(value)} ${UNDERLINE_SATURATION}% ${UNDERLINE_LIGHTNESS}%)` };
}

export type EqHashProps = {
  value: string | null | undefined;
  label?: string;
  length?: number;
  className?: string;
};

/** HashChip with the equality underline. */
export function EqHash({ value, label, length = 12, className }: EqHashProps) {
  if (!value) return <HashChip value={value} label={label} length={length} className={className} />;
  return (
    <span className={cn('inline-flex max-w-full align-middle', className)} style={underlineStyle(value)}>
      <HashChip value={value} label={label} length={length} className="rounded-b-none border-b-0" />
    </span>
  );
}

/** Full hex digest, wrapped, with the equality underline (for failing rows and confirm blocks). */
export function FullHash({ value, className }: { value: string | null | undefined; className?: string }) {
  if (!value) return <span className={cn('mono text-muted-foreground', className)}>—</span>;
  return (
    <span className={cn('mono inline break-all pb-px text-xs leading-5', className)} style={underlineStyle(value)} title={value}>
      {value}
    </span>
  );
}

export type HashVerdictProps = {
  left: string | null | undefined;
  right: string | null | undefined;
  className?: string;
};

/** 哈希一致 / 不一致 / 尚无 pill for two digests. */
export function HashVerdict({ left, right, className }: HashVerdictProps) {
  const { t } = useLanguage();
  if (!left || !right) return <span className={cn('pill pill-neutral', className)}>{t('Not yet', '尚无')}</span>;
  return left === right ? (
    <span className={cn('pill pill-policy', className)}>{t('Hashes match', '哈希一致')}</span>
  ) : (
    <span className={cn('pill pill-blocker', className)}>{t('Hashes differ', '哈希不一致')}</span>
  );
}
