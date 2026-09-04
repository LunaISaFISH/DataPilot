'use client';

import { DataTable, type DataTableColumn } from '@/components/datapilot';
import { formatInt } from '@/lib/format';
import { useLanguage } from '@/lib/language';
import { label } from '@/lib/labels';
import type { ChangePreview, ChangePreviewItem } from '@/lib/types';

export type ChangePreviewTableProps = {
  preview: ChangePreview;
  onSelectFinding?: (findingId: string) => void;
  maxHeight?: number;
};

function cell(value: string): string {
  return value === '' ? '∅' : value;
}

/** Cell-level change preview from `POST /dry-run` (display_key, 列, 修改前 → 修改后, 发现, action). */
export function ChangePreviewTable({ preview, onSelectFinding, maxHeight = 360 }: ChangePreviewTableProps) {
  const { t, language } = useLanguage();
  const columns: DataTableColumn<ChangePreviewItem>[] = [
    { key: 'display_key', header: t('Record', '记录'), render: (row) => <span className="mono">{row.display_key}</span> },
    { key: 'column', header: t('Column', '列'), render: (row) => <span className="mono">{row.column}</span> },
    {
      key: 'change',
      header: `${t('Before', '修改前')} → ${t('After', '修改后')}`,
      render: (row) => (
        <span className="mono inline-flex flex-wrap items-baseline gap-1.5 text-xs">
          <span className="text-muted-foreground line-through decoration-blocker/60">{cell(row.before)}</span>
          <span className="text-muted-foreground">→</span>
          <span className="font-semibold">{cell(row.after)}</span>
        </span>
      ),
    },
    { key: 'finding_id', header: t('Finding', '发现'), render: (row) => <span className="mono">{row.finding_id}</span> },
    { key: 'action_type', header: t('Action', '动作'), render: (row) => label('allowed_action', row.action_type, language) },
  ];
  const totalEntries = Object.entries(preview.totals);
  return (
    <div className="flex flex-col">
      <DataTable
        columns={columns}
        rows={preview.changes}
        rowKey={(row, index) => `${row.record_uid}-${row.column}-${index}`}
        onRowClick={onSelectFinding ? (row) => onSelectFinding(row.finding_id) : undefined}
        maxHeight={maxHeight}
        emptyTitle={t('No cell changes', '没有单元格变更')}
        emptyDescription={t('Row-level actions (quarantine, exclude, flag) do not rewrite cells and therefore have no preview rows.', '行级动作（隔离、排除、标记）不改写单元格，因此没有预览行。')}
        ariaLabel={t('Change preview', '变更预览')}
      />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border px-3 py-1.5 text-[11px] text-muted-foreground">
        <span>
          {t('Preview rows', '预览行')} <span className="mono">{formatInt(preview.changes.length)}</span>
        </span>
        {totalEntries.map(([key, value]) => (
          <span key={key}>
            {label('allowed_action', key, language)} <span className="mono">{formatInt(value)}</span>
          </span>
        ))}
        {preview.truncated ? (
          <span className="text-review">{t('Preview truncated; the full cell-level ledger is changes.jsonl after apply.', '预览已截断；应用后完整的单元格账本为 changes.jsonl。')}</span>
        ) : null}
      </div>
    </div>
  );
}
