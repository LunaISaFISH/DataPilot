'use client';

import { formatInt, formatScore } from '@/lib/format';
import { pick, useLanguage } from '@/lib/language';
import { label } from '@/lib/labels';
import type { MetricScore } from '@/lib/types';
import { cn } from '@/lib/utils';

export type MetricTileProps = {
  metric: MetricScore;
  /** Optional comparison value (e.g. baseline score) rendered as a delta. */
  compareTo?: number | null;
  className?: string;
};

export function MetricTile({ metric, compareTo, className }: MetricTileProps) {
  const { t, language } = useLanguage();
  const delta =
    compareTo !== undefined && compareTo !== null && metric.score !== null ? metric.score - compareTo : null;
  return (
    <div
      className={cn('panel flex flex-col gap-1 px-3 py-2.5', !metric.applicable && 'opacity-70', className)}
      data-applicable={metric.applicable}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold text-muted-foreground">{label('metric', metric.name, language)}</span>
        {!metric.applicable ? <span className="pill pill-neutral">{t('Not applicable', '不适用')}</span> : null}
      </div>
      <div className="flex items-baseline gap-2">
        <span className="mono text-2xl font-semibold leading-none tracking-tight">
          {metric.applicable ? formatScore(metric.score) : '—'}
        </span>
        {delta !== null ? (
          <span className={cn('mono text-xs', delta > 0 ? 'text-policy' : delta < 0 ? 'text-blocker' : 'text-muted-foreground')}>
            {delta > 0 ? '+' : ''}
            {delta.toFixed(2)}
          </span>
        ) : null}
      </div>
      <div className="mono text-[11px] text-muted-foreground">
        {formatInt(metric.numerator)} / {formatInt(metric.denominator)}
      </div>
      <div className="text-[11px] leading-4 text-muted-foreground">{pick(language, metric.scope_zh, metric.scope_en)}</div>
    </div>
  );
}
