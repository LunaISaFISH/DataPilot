'use client';

import { formatInt } from '@/lib/format';
import { useLanguage } from '@/lib/language';
import type { DryRunReport, ReleaseManifest } from '@/lib/types';
import { cn } from '@/lib/utils';

export type ReconciliationCounts = {
  total: number | null;
  eligible: number;
  quarantined: number;
  excluded: number;
  flagged: number;
};

export function countsFromDryRun(dryRun: DryRunReport, recordCount: number | null): ReconciliationCounts {
  return {
    total: recordCount,
    eligible: dryRun.eligible_record_count,
    quarantined: dryRun.quarantined_record_count,
    excluded: dryRun.excluded_record_count,
    flagged: dryRun.flagged_record_count,
  };
}

export function countsFromManifest(manifest: ReleaseManifest): ReconciliationCounts {
  return {
    total: manifest.total_source_records,
    eligible: manifest.eligible_record_count,
    quarantined: manifest.quarantined_record_uids.length,
    excluded: manifest.excluded_record_uids.length,
    flagged: manifest.flagged_record_uids.length,
  };
}

function Term({ k, v }: { k: string; v: number | null }) {
  return (
    <span className="inline-flex items-baseline gap-1">
      <span className="text-muted-foreground">{k}</span>
      <span className="mono font-semibold">{formatInt(v)}</span>
    </span>
  );
}

/**
 * 总记录 N = 可发布 a + 隔离 b + 排除 c (+ 标记 d). Flagged rows stay in the release, so they are
 * shown but not added. The equality is computed here from the real counts, never asserted.
 */
export function Reconciliation({ counts, className }: { counts: ReconciliationCounts; className?: string }) {
  const { t } = useLanguage();
  const sum = counts.eligible + counts.quarantined + counts.excluded;
  const known = counts.total !== null;
  const balanced = known && sum === counts.total;
  return (
    <div className={cn('flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[13px]', className)} aria-live="polite">
      <Term k={t('Total records', '总记录')} v={counts.total} />
      <span className={cn('mono', balanced ? 'text-policy' : known ? 'text-blocker' : 'text-muted-foreground')}>{known ? (balanced ? '=' : '≠') : '='}</span>
      <Term k={t('Releasable', '可发布')} v={counts.eligible} />
      <span className="mono text-muted-foreground">+</span>
      <Term k={t('Quarantined', '隔离')} v={counts.quarantined} />
      <span className="mono text-muted-foreground">+</span>
      <Term k={t('Excluded', '排除')} v={counts.excluded} />
      <span className="text-muted-foreground">(</span>
      <Term k={t('Flagged, kept in release', '标记·仍在发布中')} v={counts.flagged} />
      <span className="text-muted-foreground">)</span>
      <span className="mono text-xs text-muted-foreground">
        {t('sum', '合计')} {formatInt(sum)}
      </span>
      {known ? (
        <span className={cn('pill', balanced ? 'pill-policy' : 'pill-blocker')}>{balanced ? t('Reconciles', '对账一致') : t('Does not reconcile', '对账不一致')}</span>
      ) : (
        <span className="pill pill-neutral">{t('Total unknown', '总数未知')}</span>
      )}
    </div>
  );
}
