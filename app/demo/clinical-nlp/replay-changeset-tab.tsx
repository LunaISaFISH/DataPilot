'use client';

import { DataTable, EmptyState, KeyValueList, PanelSection, Pill, type DataTableColumn } from '@/components/datapilot';
import { formatInt } from '@/lib/format';
import { useLanguage } from '@/lib/language';
import { label } from '@/lib/labels';

import type { ReplayAction, ReplayBundle } from './replay-data';
import { HashOrUnavailable, IntOrUnavailable, Unavailable } from './replay-ui';

function scopeText(action: ReplayAction, t: (en: string, zh: string) => string): string {
  const parts: string[] = [];
  if (action.column) parts.push(action.column);
  if (action.mapping) parts.push(`${formatInt(Object.keys(action.mapping).length)} ${t('mappings', '条映射')}`);
  if (action.source_format && action.target_format) parts.push(`${action.source_format} → ${action.target_format}`);
  if (action.record_uid_count !== null) parts.push(`${formatInt(action.record_uid_count)} ${t('records', '条记录')}`);
  return parts.length > 0 ? parts.join(' · ') : '—';
}

function Term({ k, v }: { k: string; v: number | null }) {
  return (
    <span className="inline-flex flex-col items-center">
      <span className="mono text-xl font-semibold leading-none">{v === null ? '—' : formatInt(v)}</span>
      <span className="text-[11px] text-muted-foreground">{k}</span>
    </span>
  );
}

export function ReplayChangesetTab({ bundle }: { bundle: ReplayBundle }) {
  const { t, language } = useLanguage();
  const dryRun = bundle.execution?.dry_run ?? null;
  if (!dryRun) {
    return (
      <EmptyState
        title={t('Change set unavailable', '变更集不可用')}
        description={t('release-report.json is missing or carries no dry_run block.', 'release-report.json 缺失或未包含 dry_run。')}
      />
    );
  }
  const manifest = bundle.manifest ?? bundle.execution?.release_manifest ?? null;
  const total = manifest?.total_source_records ?? bundle.report?.profile.record_count ?? null;
  const eligible = dryRun.eligible_record_count;
  const quarantined = dryRun.quarantined_record_count;
  const excluded = dryRun.excluded_record_count;
  const sum = eligible !== null && quarantined !== null && excluded !== null ? eligible + quarantined + excluded : null;
  const reconciles = total !== null && sum !== null ? total === sum : null;

  const columns: DataTableColumn<ReplayAction>[] = [
    { key: 'action_type', header: t('Action', '动作'), render: (row) => (
      <span className="inline-flex flex-col">
        <span>{label('allowed_action', row.action_type, language)}</span>
        <span className="mono text-[11px] text-muted-foreground">{row.action_type}</span>
      </span>
    ) },
    { key: 'finding_id', header: t('Finding', '发现'), render: (row) => <span className="mono text-xs">{row.finding_id ?? '—'}</span> },
    {
      key: 'authorization_source',
      header: t('Authorized by', '授权来源'),
      render: (row) =>
        row.authorization_source ? (
          <Pill variant={row.authorization_source === 'POLICY' ? 'policy' : 'review'}>{label('authorization_source', row.authorization_source, language)}</Pill>
        ) : (
          '—'
        ),
    },
    { key: 'authorization_ref', header: t('Reference', '授权引用'), render: (row) => <span className="mono text-xs">{row.authorization_ref ?? '—'}</span> },
    { key: 'scope', header: t('Scope', '范围'), render: (row) => <span className="text-xs">{scopeText(row, t)}</span> },
  ];

  const dispositionRows = Object.entries(dryRun.finding_dispositions).map(([findingId, disposition]) => ({ findingId, disposition }));
  const dispositionColumns: DataTableColumn<(typeof dispositionRows)[number]>[] = [
    { key: 'findingId', header: t('Finding', '发现'), render: (row) => <span className="mono text-xs">{row.findingId}</span> },
    { key: 'disposition', header: t('Disposition', '处置'), render: (row) => (
      <span className="inline-flex items-center gap-2">
        <span>{label('disposition', row.disposition, language)}</span>
        <span className="mono text-[11px] text-muted-foreground">{row.disposition}</span>
      </span>
    ) },
  ];

  return (
    <div className="flex flex-col gap-3">
      <PanelSection
        id="replay-actions"
        title={t('Typed actions', '类型化动作')}
        description={t('Only allow-listed action types are executed; each carries its authorization source and reference.', '仅执行允许列表中的动作类型；每条动作都带有授权来源与引用。')}
        actions={<span className="mono text-[11px] text-muted-foreground">{formatInt(dryRun.actions.length)} · {dryRun.status ?? '—'}</span>}
        flush
      >
        <DataTable columns={columns} rows={dryRun.actions} rowKey={(row, index) => `${row.finding_id ?? row.action_type}-${index}`} className="rounded-none border-0" ariaLabel={t('Approved actions', '已批准动作')} emptyTitle={t('No actions recorded', '未记录动作')} />
      </PanelSection>

      <div className="grid gap-3 xl:grid-cols-2">
        <PanelSection
          id="replay-reconciliation"
          title={t('Reconciliation', '行数对账')}
          description={t('总记录 = 可发布 + 隔离 + 排除; flagged rows stay in the release.', '总记录 = 可发布 + 隔离 + 排除；标记待审的记录仍在发布文件内。')}
        >
          <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-2 py-2">
            <Term k={t('total', '总记录')} v={total} />
            <span className="mono text-lg text-muted-foreground">=</span>
            <Term k={t('eligible', '可发布')} v={eligible} />
            <span className="mono text-lg text-muted-foreground">+</span>
            <Term k={t('quarantined', '隔离')} v={quarantined} />
            <span className="mono text-lg text-muted-foreground">+</span>
            <Term k={t('excluded', '排除')} v={excluded} />
          </div>
          <div className="flex items-center justify-center gap-2 text-xs">
            {reconciles === null ? (
              <Unavailable reason={t('a term is missing from the artifact', '工件缺少某一项')} />
            ) : (
              <Pill variant={reconciles ? 'policy' : 'blocker'}>
                {reconciles ? t('Arithmetic holds', '等式成立') : t('Arithmetic does not hold', '等式不成立')} · {formatInt(sum)} / {formatInt(total)}
              </Pill>
            )}
            {dryRun.flagged_record_count !== null ? (
              <span className="text-muted-foreground">
                {t('flagged', '标记待审')} <span className="mono">{formatInt(dryRun.flagged_record_count)}</span>
              </span>
            ) : null}
          </div>
        </PanelSection>

        <PanelSection id="replay-changeset-hashes" title={t('Change set identity', '变更集标识')}>
          <KeyValueList
            items={[
              { key: 'revision', label: t('Run revision', '运行版本号'), value: <IntOrUnavailable value={dryRun.run_revision} /> },
              { key: 'source', label: t('Source artifact hash', '源文件哈希'), value: <HashOrUnavailable value={dryRun.source_artifact_hash} length={16} /> },
              { key: 'actions', label: 'approved_action_set_hash', value: <HashOrUnavailable value={dryRun.approved_action_set_hash} length={16} /> },
              { key: 'decisions', label: 'decision_set_hash', value: <HashOrUnavailable value={dryRun.decision_set_hash} length={16} /> },
              { key: 'affected_records', label: t('Affected records', '受影响记录'), value: <IntOrUnavailable value={dryRun.affected_record_count} /> },
              { key: 'affected_cells', label: t('Affected cells', '受影响单元格'), value: <IntOrUnavailable value={dryRun.affected_cell_count} /> },
              {
                key: 'excluded_columns',
                label: t('Excluded columns', '排除字段'),
                value: dryRun.excluded_columns.length === 0 ? t('None', '无') : <span className="mono text-xs">{dryRun.excluded_columns.join(', ')}</span>,
              },
              {
                key: 'blocking_unresolved',
                label: t('Blocking unresolved', '未处置的阻断项'),
                value: dryRun.blocking_unresolved.length === 0 ? t('None', '无') : <span className="mono text-xs">{dryRun.blocking_unresolved.join(', ')}</span>,
              },
            ]}
          />
        </PanelSection>
      </div>

      <PanelSection id="replay-dispositions" title={t('Recorded dispositions', '已记录处置')} flush>
        <DataTable columns={dispositionColumns} rows={dispositionRows} rowKey={(row) => row.findingId} className="rounded-none border-0" ariaLabel={t('Dispositions', '处置')} emptyTitle={t('No dispositions recorded', '未记录处置')} />
      </PanelSection>

      <p className="text-xs text-muted-foreground">
        {t('The cell-level change preview (changes.jsonl) is not part of the replay artifacts; it is available in the live console.', '单元格级变更预览（changes.jsonl）不随回放工件提供；实时控制台中可查看。')}
      </p>
    </div>
  );
}
