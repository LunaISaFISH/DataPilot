'use client';

import { DataTable, type DataTableColumn } from '@/components/datapilot';
import { pick, useLanguage } from '@/lib/language';
import { label } from '@/lib/labels';
import type { EvidenceSignal, EvidenceStatus } from '@/lib/types';
import { cn } from '@/lib/utils';

const glyph: Record<EvidenceStatus, { char: string; tone: string }> = {
  PASS: { char: '✓', tone: 'text-policy' },
  FAIL: { char: '✗', tone: 'text-blocker' },
  NOT_APPLICABLE: { char: '–', tone: 'text-muted-foreground' },
};

function StatusGlyph({ status, className }: { status: EvidenceStatus; className?: string }) {
  const { language } = useLanguage();
  const g = glyph[status] ?? glyph.NOT_APPLICABLE;
  return (
    <span className={cn('mono font-semibold', g.tone, className)} aria-label={label('evidence_status', status, language)}>
      {g.char}
    </span>
  );
}

/** Compact ✓ ✗ – row for the findings table; signal name and explanation on hover. */
export function EvidenceGlyphs({ signals }: { signals: EvidenceSignal[] }) {
  const { language } = useLanguage();
  if (signals.length === 0) return <span className="text-muted-foreground">—</span>;
  return (
    <span className="inline-flex items-center gap-1">
      {signals.map((signal, index) => (
        <span
          key={`${signal.signal}-${index}`}
          title={`${label('evidence_signal', signal.signal, language)} · ${label('evidence_status', signal.status, language)}\n${pick(language, signal.explanation_zh, signal.explanation_en)}`}
          className="inline-flex"
        >
          <StatusGlyph status={signal.status} />
        </span>
      ))}
    </span>
  );
}

/** Full evidence signals table for the inspector. */
export function EvidenceTable({ signals, maxHeight }: { signals: EvidenceSignal[]; maxHeight?: number }) {
  const { t, language } = useLanguage();
  const columns: DataTableColumn<EvidenceSignal>[] = [
    {
      key: 'status',
      header: t('Status', '状态'),
      align: 'center',
      width: 44,
      render: (row) => <StatusGlyph status={row.status} className="text-sm" />,
    },
    {
      key: 'signal',
      header: t('Signal and explanation', '信号与说明'),
      render: (row) => (
        <span className="flex flex-col gap-0.5">
          <span className="flex flex-wrap items-baseline gap-x-2">
            <span>{label('evidence_signal', row.signal, language)}</span>
            <span className="mono hidden text-[11px] text-muted-foreground sm:inline">{row.signal}</span>
          </span>
          <span className="text-xs leading-4 text-muted-foreground">{pick(language, row.explanation_zh, row.explanation_en)}</span>
        </span>
      ),
    },
    {
      key: 'evidence_ref',
      header: t('Ref', '证据编号'),
      render: (row) => <span className="mono text-[11px] whitespace-nowrap">{row.evidence_ref}</span>,
    },
  ];
  return (
    <DataTable
      columns={columns}
      rows={signals}
      rowKey={(row, index) => `${row.signal}-${row.evidence_ref}-${index}`}
      maxHeight={maxHeight}
      emptyTitle={t('No evidence signals', '没有证据信号')}
      ariaLabel={t('Evidence signals', '证据信号')}
    />
  );
}
