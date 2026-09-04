'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

import { DataTable, EmptyState, Pill, ProvenanceMark, provenanceFromProposal, type DataTableColumn } from '@/components/datapilot';
import { formatInt } from '@/lib/format';
import { pick, useLanguage } from '@/lib/language';
import { label } from '@/lib/labels';
import type { AuthorizationMode, Finding, RiskLevel } from '@/lib/types';
import { cn } from '@/lib/utils';

import { useWorkspace } from '../workspace-context';
import { EvidenceGlyphs } from './finding/evidence-table';
import { AuthCodeChip, RiskDot, Stat, dispositionOf, ledgerRecordFor, proposalSource } from './finding/helpers';

const RISKS: readonly RiskLevel[] = ['HIGH', 'MEDIUM', 'LOW'];
const MODES: readonly AuthorizationMode[] = ['POLICY_AUTHORIZED', 'HUMAN_APPROVAL_REQUIRED', 'QUARANTINE_ONLY', 'FORBIDDEN'];
const RISK_ORDER: Record<RiskLevel, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };

type ModeFilter = 'all' | AuthorizationMode | 'blocking';

function modeFilterLabel(filter: ModeFilter, language: 'zh' | 'en'): string {
  switch (filter) {
    case 'all':
      return language === 'zh' ? '全部' : 'All';
    case 'blocking':
      return language === 'zh' ? '阻断发布' : 'Blocking';
    case 'POLICY_AUTHORIZED':
      return language === 'zh' ? '策略可自动授权' : 'Policy authorized';
    case 'HUMAN_APPROVAL_REQUIRED':
      return language === 'zh' ? '需人工决策' : 'Human decision';
    case 'QUARANTINE_ONLY':
      return language === 'zh' ? '仅允许隔离' : 'Quarantine only';
    case 'FORBIDDEN':
      return language === 'zh' ? '禁止自动处理' : 'Forbidden';
    default:
      return filter;
  }
}

function SourceCell({ finding }: { finding: Finding }) {
  const { t } = useLanguage();
  const { ledger } = useWorkspace();
  const source = proposalSource(finding, ledgerRecordFor(finding, ledger));
  if (finding.proposal) {
    return (
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
        <ProvenanceMark provenance={provenanceFromProposal(finding.proposal)} />
        {source === 'ai_rejected' ? <span className="text-[11px] text-blocker">{t('AI rejected', 'AI 被拒')}</span> : null}
        {source === 'ai_abstained' ? <span className="text-[11px] text-muted-foreground">{t('abstained', '弃权')}</span> : null}
      </span>
    );
  }
  if (source === 'ineligible') {
    return (
      <Pill variant="neutral" className="font-normal" title={t('Nothing can be proposed for this finding under the contract.', '契约下该问题没有可提议的动作。')}>
        {t('Not eligible', '无资格')}
      </Pill>
    );
  }
  return <ProvenanceMark provenance={{ provider: 'deterministic' }} />;
}

/**
 * 发现 tab: the dense findings table (spec §9.2). Row selection drives the right pane; arrow keys
 * move the selection; the strip above summarises risk, authorization modes and blockers.
 */
export function FindingsTab() {
  const { t, language } = useLanguage();
  const { run, selectedFindingId, setSelectedFindingId } = useWorkspace();
  const [filter, setFilter] = useState<ModeFilter>('all');
  const wrapper = useRef<HTMLDivElement>(null);

  const findings = useMemo(() => run?.report?.findings ?? [], [run]);

  const sorted = useMemo(
    () =>
      [...findings].sort((a, b) => {
        if (a.blocking !== b.blocking) return a.blocking ? -1 : 1;
        const risk = RISK_ORDER[a.risk_level] - RISK_ORDER[b.risk_level];
        if (risk !== 0) return risk;
        return a.finding_id.localeCompare(b.finding_id);
      }),
    [findings],
  );

  const visible = useMemo(() => {
    if (filter === 'all') return sorted;
    if (filter === 'blocking') return sorted.filter((finding) => finding.blocking);
    return sorted.filter((finding) => finding.authorization_mode === filter);
  }, [sorted, filter]);

  // Keep keyboard focus on the selected row when the selection moved by keyboard.
  useEffect(() => {
    const root = wrapper.current;
    if (!root || !selectedFindingId) return;
    if (!root.contains(document.activeElement)) return;
    const row = root.querySelector<HTMLTableRowElement>('tr[data-selected="true"]');
    if (row && row !== document.activeElement) row.focus();
  }, [selectedFindingId]);

  if (!run?.report) {
    return <EmptyState title={t('No report yet', '尚无报告')} />;
  }

  const byRisk = RISKS.map((risk) => ({ risk, count: findings.filter((finding) => finding.risk_level === risk).length }));
  const byMode = MODES.map((mode) => ({ mode, count: findings.filter((finding) => finding.authorization_mode === mode).length }));
  const blocking = findings.filter((finding) => finding.blocking).length;
  const filters: ModeFilter[] = ['all', ...MODES.filter((mode) => byMode.find((entry) => entry.mode === mode)?.count), ...(blocking ? (['blocking'] as const) : [])];

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    if (visible.length === 0) return;
    event.preventDefault();
    const index = visible.findIndex((finding) => finding.finding_id === selectedFindingId);
    const next = event.key === 'ArrowDown' ? Math.min(visible.length - 1, index + 1) : Math.max(0, index <= 0 ? 0 : index - 1);
    setSelectedFindingId(visible[next].finding_id);
  };

  const columns: DataTableColumn<Finding>[] = [
    {
      key: 'finding_id',
      header: 'ID',
      render: (row) => (
        <span className="inline-flex items-center gap-1.5">
          <span className="mono text-xs whitespace-nowrap">{row.finding_id}</span>
          {row.blocking ? <span className="inline-block size-1.5 rounded-full bg-blocker" title={t('Blocking', '阻断发布')} aria-label={t('Blocking', '阻断发布')} /> : null}
        </span>
      ),
    },
    {
      key: 'title',
      header: t('Title', '标题'),
      render: (row) => (
        <span className="line-clamp-2 min-w-[10ch] text-xs leading-4" title={pick(language, row.title_zh, row.title_en)}>
          {pick(language, row.title_zh, row.title_en)}
        </span>
      ),
    },
    { key: 'column', header: t('Column', '列'), render: (row) => (row.column ? <span className="mono text-xs">{row.column}</span> : <span className="text-muted-foreground">—</span>) },
    { key: 'risk', header: t('Risk', '风险'), render: (row) => <RiskDot value={row.risk_level} className="text-xs" /> },
    { key: 'authorization_mode', header: t('Auth', '授权模式'), render: (row) => <AuthCodeChip value={row.authorization_mode} /> },
    {
      key: 'counts',
      header: `${t('Records', '记录')} / ${t('cells', '单元格')}`,
      align: 'right',
      render: (row) => (
        <span title={`${t('Records', '记录')} ${formatInt(row.affected_record_count)} · ${t('Cells', '单元格')} ${formatInt(row.affected_cell_count)}`}>
          {formatInt(row.affected_record_count)} <span className="text-muted-foreground">/</span> {formatInt(row.affected_cell_count)}
        </span>
      ),
    },
    { key: 'evidence', header: t('Evidence', '证据'), render: (row) => <EvidenceGlyphs signals={row.evidence_signals} /> },
    { key: 'source', header: t('Proposal', '提议来源'), render: (row) => <SourceCell finding={row} /> },
    {
      key: 'disposition',
      header: t('Disposition', '处置'),
      render: (row) => {
        const view = dispositionOf(row, run, language);
        return (
          <span
            className={cn(
              'text-xs whitespace-nowrap',
              view.tone === 'policy' && 'text-policy',
              view.tone === 'blocker' && 'text-blocker',
              view.tone === 'review' && 'text-review',
              view.tone === 'info' && 'text-info',
              view.tone === 'neutral' && 'text-muted-foreground',
            )}
            title={view.source === 'dry_run' ? t('from the change set', '来自变更集') : view.source === 'decision' ? t('saved decision, change set not generated', '已保存的处置，尚未生成变更集') : t('from the report', '来自报告')}
          >
            {view.text}
            {view.source === 'decision' ? <span className="text-muted-foreground"> ·</span> : null}
          </span>
        );
      },
    },
  ];

  return (
    <div ref={wrapper} role="presentation" className="flex flex-col gap-2 p-3" onKeyDown={onKeyDown}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-md border border-border bg-card px-3 py-1.5">
        <Stat k={t('findings', '问题')} v={formatInt(findings.length)} />
        <Stat k={t('blocking', '阻断')} v={formatInt(blocking)} tone={blocking ? 'blocker' : 'muted'} />
        <span className="h-4 w-px bg-border" aria-hidden="true" />
        {byRisk.map(({ risk, count }) => (
          <span key={risk} className="inline-flex items-center gap-1.5 text-xs">
            <RiskDot value={risk} />
            <span className="mono text-xs">{formatInt(count)}</span>
          </span>
        ))}
        <span className="h-4 w-px bg-border" aria-hidden="true" />
        {byMode.map(({ mode, count }) => (
          <span key={mode} className="inline-flex items-center gap-1.5 text-xs" title={label('authorization_mode', mode, language)}>
            <AuthCodeChip value={mode} />
            <span className="mono text-xs">{formatInt(count)}</span>
          </span>
        ))}
        {run.report.release_status ? (
          <>
            <span className="h-4 w-px bg-border" aria-hidden="true" />
            <Stat k={t('release', '发布')} v={label('release_status', run.report.release_status, language)} tone={run.report.release_status === 'BLOCKED' ? 'blocker' : run.report.release_status === 'PASS' ? 'policy' : undefined} />
          </>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div role="tablist" aria-label={t('Filter by authorization mode', '按授权模式筛选')} className="inline-flex flex-wrap items-center gap-1">
          {filters.map((entry) => {
            const count = entry === 'all' ? findings.length : entry === 'blocking' ? blocking : (byMode.find((mode) => mode.mode === entry)?.count ?? 0);
            const active = filter === entry;
            return (
              <button
                key={entry}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setFilter(entry)}
                className={cn(
                  'inline-flex h-6 items-center gap-1.5 rounded-md border px-2 text-xs transition-colors',
                  active ? 'border-foreground bg-foreground text-background' : 'border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground',
                )}
              >
                {modeFilterLabel(entry, language)}
                <span className="mono">{formatInt(count)}</span>
              </button>
            );
          })}
        </div>
        <span className="text-[11px] text-muted-foreground">{t('Click a row to inspect · ↑ ↓ to move', '点击行查看详情 · ↑ ↓ 切换')}</span>
      </div>

      <DataTable
        columns={columns}
        rows={visible}
        rowKey={(row) => row.finding_id}
        onRowClick={(row) => setSelectedFindingId(row.finding_id)}
        selectedKey={selectedFindingId}
        emptyTitle={findings.length === 0 ? t('No findings', '没有发现问题') : t('No findings match the filter', '没有符合筛选条件的问题')}
        emptyDescription={findings.length === 0 ? t('The detectors found nothing to report for this dataset under the current contract.', '在当前契约下，检测器未在该数据集中发现任何问题。') : undefined}
        ariaLabel={t('Findings', '发现')}
        tableClassName="[&_td]:px-1.5 [&_th]:px-1.5"
      />
    </div>
  );
}
