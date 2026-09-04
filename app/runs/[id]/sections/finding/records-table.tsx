'use client';

import { useEffect, useState } from 'react';

import { DataTable, MaskedValue, Pill, type DataTableColumn } from '@/components/datapilot';
import { ApiError, getFindingRecords } from '@/lib/api';
import { formatInt } from '@/lib/format';
import { useLanguage } from '@/lib/language';
import type { FindingRecords } from '@/lib/types';
import { cn } from '@/lib/utils';

import { GuardRow } from '@/components/datapilot';

const RECORD_LIMIT = 20;

type Row = { index: number; cells: string[] };

/**
 * 受影响记录: `GET /v1/runs/{id}/findings/{fid}/records?limit=20`. The server masks sensitive
 * columns; the table marks which ones so nobody mistakes a mask for data.
 */
export function RecordsTable({ runId, findingId, affectedRecordCount, highlightColumn }: {
  runId: string;
  findingId: string;
  affectedRecordCount: number;
  highlightColumn: string | null;
}) {
  const { t } = useLanguage();
  // Mount with `key={findingId}` so a new finding starts from an empty state.
  const [records, setRecords] = useState<FindingRecords | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    getFindingRecords(runId, findingId, RECORD_LIMIT, controller.signal)
      .then((result) => {
        if (cancelled) return;
        setRecords(result);
        setError(null);
      })
      .catch((reason: unknown) => {
        if (cancelled || (reason instanceof DOMException && reason.name === 'AbortError')) return;
        if (reason instanceof ApiError) setError(reason);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [runId, findingId, attempt]);

  const retry = () => {
    setError(null);
    setRecords(null);
    setAttempt((n) => n + 1);
  };

  if (error) {
    return <GuardRow error={error} title={t('Records unavailable', '无法加载记录')} onRetry={retry} />;
  }
  if (!records) {
    return (
      <output className="flex min-h-16 items-center gap-2 text-xs text-muted-foreground">
        <span className="size-2 rounded-full bg-policy motion-safe:animate-pulse" aria-hidden="true" />
        {t('Loading related records…', '正在加载相关记录…')}
      </output>
    );
  }

  const masked = new Set(records.masked_columns);
  const rows: Row[] = records.rows.map((cells, index) => ({ index, cells }));
  const columns: DataTableColumn<Row>[] = records.columns.map((name, columnIndex) => ({
    key: `${name}-${columnIndex}`,
    header: (
      <span className={cn('inline-flex items-center gap-1', name === highlightColumn && 'text-foreground underline decoration-review decoration-2 underline-offset-4')}>
        <span className="mono">{name}</span>
        {masked.has(name) ? <span className="text-[10px] font-normal text-muted-foreground">{t('masked', '已遮蔽')}</span> : null}
      </span>
    ),
    render: (row) => <MaskedValue value={row.cells[columnIndex]} masked={masked.has(name) ? true : undefined} className="text-xs" />,
  }));

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
        <span>
          {t('Showing', '已显示')} <span className="mono">{formatInt(records.rows.length)}</span> / <span className="mono">{formatInt(affectedRecordCount)}</span>{' '}
          {t('affected records', '条相关记录')}
        </span>
        {records.masked_columns.length > 0 ? (
          <span className="inline-flex flex-wrap items-center gap-1">
            {t('Masked by the server:', '服务端已遮蔽：')}
            {records.masked_columns.map((name) => (
              <Pill key={name} variant="neutral" className="mono font-normal">
                {name}
              </Pill>
            ))}
          </span>
        ) : (
          <span>{t('No sensitive columns in this sample.', '本样本不含敏感字段。')}</span>
        )}
      </div>
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(row) => String(row.index)}
        maxHeight={260}
        emptyTitle={t('No sample rows returned', '未返回样本行')}
        ariaLabel={t('Affected records', '受影响记录')}
      />
    </div>
  );
}
