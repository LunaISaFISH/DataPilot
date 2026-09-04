'use client';

import { DataTable, Pill, type DataTableColumn } from '@/components/datapilot';
import { formatInt } from '@/lib/format';
import { useLanguage } from '@/lib/language';
import { label } from '@/lib/labels';
import type { ApprovedAction } from '@/lib/types';

/** 范围: record count for row-scoped actions, the column for column-scoped ones. */
export function actionScope(action: ApprovedAction, t: (en: string, zh: string) => string): string {
  switch (action.action_type) {
    case 'EXCLUDE_COLUMN_FROM_RELEASE':
      return `${t('column', '字段')} ${action.column}`;
    case 'NORMALIZE_CATEGORY':
      return `${formatInt(action.record_uids.length)} ${t('records', '条记录')} · ${action.column} · ${formatInt(Object.keys(action.mapping).length)} ${t('mappings', '个映射')}`;
    case 'STANDARDIZE_DATE_FORMAT':
      return `${formatInt(action.record_uids.length)} ${t('records', '条记录')} · ${action.column} · ${action.source_format} → ${action.target_format}`;
    default:
      return `${formatInt(action.record_uids.length)} ${t('records', '条记录')}`;
  }
}

export type ActionTableProps = {
  actions: ApprovedAction[];
  onSelectFinding?: (findingId: string) => void;
  maxHeight?: number;
};

/** Typed approved-action table (spec §9.2 变更集). */
export function ActionTable({ actions, onSelectFinding, maxHeight = 320 }: ActionTableProps) {
  const { t, language } = useLanguage();
  const columns: DataTableColumn<ApprovedAction>[] = [
    {
      key: 'action_type',
      header: t('Action', '动作'),
      render: (row) => (
        <span className="flex flex-col">
          <span>{label('allowed_action', row.action_type, language)}</span>
          <span className="mono text-[11px] text-muted-foreground">{row.action_type}</span>
        </span>
      ),
    },
    { key: 'finding_id', header: t('Finding', '发现'), render: (row) => <span className="mono">{row.finding_id}</span> },
    {
      key: 'authorization_source',
      header: t('Authorized by', '授权来源'),
      render: (row) => (
        <Pill variant={row.authorization_source === 'POLICY' ? 'policy' : 'review'}>{label('authorization_source', row.authorization_source, language)}</Pill>
      ),
    },
    { key: 'authorization_ref', header: t('Authorization ref', '授权引用'), render: (row) => <span className="mono break-all text-xs">{row.authorization_ref}</span> },
    { key: 'scope', header: t('Scope', '范围'), render: (row) => <span className="mono text-xs">{actionScope(row, t)}</span> },
  ];
  return (
    <DataTable
      columns={columns}
      rows={actions}
      rowKey={(row, index) => `${row.finding_id}-${row.action_type}-${index}`}
      onRowClick={onSelectFinding ? (row) => onSelectFinding(row.finding_id) : undefined}
      maxHeight={maxHeight}
      emptyTitle={t('No approved actions', '没有已批准的动作')}
      emptyDescription={t('The dry run produced an empty action set; applying it changes nothing.', '预演产生了空动作集；应用后不会改变任何内容。')}
      ariaLabel={t('Approved actions', '已批准动作')}
    />
  );
}
