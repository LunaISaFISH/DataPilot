'use client';

import { DataTable, type DataTableColumn } from '@/components/datapilot';
import { formatInt } from '@/lib/format';
import { pick, useLanguage } from '@/lib/language';
import { label } from '@/lib/labels';
import type { ValidationResult } from '@/lib/types';
import { cn } from '@/lib/utils';

import { isHashLike } from '@/components/datapilot';
import { EqHash, FullHash } from './hash-equality';

/** observed/expected cell: hashes as chips (full text when the row failed), everything else mono. */
export function ValidationValue({ value, full }: { value: unknown; full: boolean }) {
  if (value === undefined || value === null) return <span className="mono text-muted-foreground">—</span>;
  if (isHashLike(value)) return full ? <FullHash value={value} /> : <EqHash value={value} length={16} />;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return <span className="mono break-all text-xs">{String(value)}</span>;
  }
  return <pre className="mono max-h-32 overflow-auto whitespace-pre-wrap break-all text-[11px] leading-4">{JSON.stringify(value, null, full ? 1 : 0)}</pre>;
}

export type ValidationTableProps = {
  validations: ValidationResult[];
  /** Check ids to emphasise (e.g. SOURCE_IMMUTABLE in the tamper test). */
  highlight?: readonly string[];
  maxHeight?: number;
  ariaLabel?: string;
};

export function validationSummary(validations: ValidationResult[]): { passed: number; failed: number } {
  let passed = 0;
  for (const check of validations) if (check.passed) passed += 1;
  return { passed, failed: validations.length - passed };
}

/** Validation table: check_id mono + label, result glyph, observed | expected side by side, 说明. */
export function ValidationTable({ validations, highlight = [], maxHeight = 420, ariaLabel }: ValidationTableProps) {
  const { t, language } = useLanguage();
  const emphasised = new Set(highlight);
  const columns: DataTableColumn<ValidationResult>[] = [
    {
      key: 'check_id',
      header: t('Check', '检查'),
      render: (row) => (
        <span className={cn('flex flex-col', emphasised.has(row.check_id) && 'font-semibold')}>
          <span>{label('validation', row.check_id, language)}</span>
          <span className="mono text-[11px] font-normal text-muted-foreground">{row.check_id}</span>
        </span>
      ),
    },
    {
      key: 'passed',
      header: t('Result', '结果'),
      align: 'center',
      width: 72,
      render: (row) => (
        <span className={cn('mono inline-flex items-center gap-1 text-xs font-semibold', row.passed ? 'text-policy' : 'text-blocker')} aria-label={row.passed ? t('Pass', '通过') : t('Fail', '未通过')}>
          <span aria-hidden="true">{row.passed ? '✓' : '✗'}</span>
          {row.passed ? t('Pass', '通过') : t('Fail', '未通过')}
        </span>
      ),
    },
    { key: 'observed', header: t('Observed', '观测'), render: (row) => <ValidationValue value={row.observed} full={!row.passed} /> },
    { key: 'expected', header: t('Expected', '期望'), render: (row) => <ValidationValue value={row.expected} full={!row.passed} /> },
    { key: 'message', header: t('Message', '说明'), render: (row) => <span className="text-xs">{pick(language, row.message_zh, row.message_en)}</span> },
  ];
  const summary = validationSummary(validations);
  return (
    <div className="flex flex-col">
      <DataTable
        columns={columns}
        rows={validations}
        rowKey={(row) => row.check_id}
        maxHeight={maxHeight}
        emptyTitle={t('No validations', '没有验证结果')}
        ariaLabel={ariaLabel ?? t('Validations', '验证')}
      />
      <div className="flex flex-wrap items-center gap-x-3 border-t border-border px-3 py-1.5 text-[11px] text-muted-foreground">
        <span className={cn('pill', summary.failed === 0 ? 'pill-policy' : 'pill-blocker')}>
          {summary.failed === 0 ? t('All checks passed', '全部通过') : t('Checks failed', '有检查未通过')}
        </span>
        <span className="mono">
          {formatInt(summary.passed)} / {formatInt(validations.length)}
        </span>
        {summary.failed > 0 ? (
          <span className="mono text-blocker">
            {validations
              .filter((check) => !check.passed)
              .map((check) => check.check_id)
              .join(' · ')}
          </span>
        ) : null}
      </div>
    </div>
  );
}
