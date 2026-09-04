'use client';

import { ChevronRight } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { DataTable, EmptyState, Pill, ProvenanceMark, provenanceFromProposal, type DataTableColumn } from '@/components/datapilot';
import { formatInt } from '@/lib/format';
import { useLanguage } from '@/lib/language';
import { findingDisplayTitle, label } from '@/lib/labels';
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
      return language === 'zh' ? '全部问题' : 'All';
    case 'blocking':
      return language === 'zh' ? '影响交付' : 'Blocking';
    case 'POLICY_AUTHORIZED':
      return language === 'zh' ? '可自动处理' : 'Policy authorized';
    case 'HUMAN_APPROVAL_REQUIRED':
      return language === 'zh' ? '需要确认' : 'Human decision';
    case 'QUARANTINE_ONLY':
      return language === 'zh' ? '仅可隔离' : 'Quarantine only';
    case 'FORBIDDEN':
      return language === 'zh' ? '仅查看' : 'Forbidden';
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
        {source === 'ai_rejected' ? <span className="text-[11px] text-blocker">{t('AI suggestion failed validation', 'AI 建议未通过校验')}</span> : null}
        {source === 'ai_abstained' ? <span className="text-[11px] text-muted-foreground">{t('withheld', '暂不判断')}</span> : null}
      </span>
    );
  }
  if (source === 'ineligible') {
    return (
      <Pill variant="neutral" className="font-normal" title={t('The release rules do not permit an automatic action for this issue.', '发布规则不允许系统自动处理这个问题。')}>
        {t('No automatic action', '暂无自动处理')}
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

  const byRisk = RISKS.map((risk) => ({
    risk,
    count: findings.filter((finding) => finding.risk_level === risk).length,
  }));
  const byMode = MODES.map((mode) => ({
    mode,
    count: findings.filter((finding) => finding.authorization_mode === mode).length,
  }));
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
      header: t('ID', '编号'),
      render: (row) => (
        <span className="inline-flex items-center gap-1.5">
          <span className="mono text-xs whitespace-nowrap">{row.finding_id}</span>
          {row.blocking ? <span className="inline-block size-1.5 rounded-full bg-blocker" title={t('Affects release', '影响交付')} aria-label={t('Affects release', '影响交付')} /> : null}
        </span>
      ),
    },
    {
      key: 'title',
      header: t('Issue', '问题'),
      render: (row) => (
        <span className="line-clamp-2 min-w-[10ch] text-xs leading-4" title={findingDisplayTitle(row, language)}>
          {findingDisplayTitle(row, language)}
        </span>
      ),
    },
    {
      key: 'column',
      header: t('Field', '字段'),
      render: (row) => (row.column ? <span className="mono text-xs">{row.column}</span> : <span className="text-muted-foreground">—</span>),
    },
    {
      key: 'risk',
      header: t('Risk', '风险'),
      render: (row) => <RiskDot value={row.risk_level} className="text-xs" />,
    },
    {
      key: 'authorization_mode',
      header: t('Handling', '处理方式'),
      render: (row) => <span className="text-xs whitespace-nowrap">{label('authorization_mode', row.authorization_mode, language)}</span>,
    },
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
    {
      key: 'evidence',
      header: t('Evidence', '依据'),
      render: (row) => <EvidenceGlyphs signals={row.evidence_signals} />,
    },
    {
      key: 'source',
      header: t('Suggestion source', '建议来源'),
      render: (row) => <SourceCell finding={row} />,
    },
    {
      key: 'disposition',
      header: t('Current status', '当前状态'),
      render: (row) => {
        const view = dispositionOf(row, run, language);
        return (
          <span
            className={cn('text-xs whitespace-nowrap', view.tone === 'policy' && 'text-policy', view.tone === 'blocker' && 'text-blocker', view.tone === 'review' && 'text-review', view.tone === 'info' && 'text-info', view.tone === 'neutral' && 'text-muted-foreground')}
            title={view.source === 'dry_run' ? t('from the execution preview', '来自执行预览') : view.source === 'decision' ? t('saved decision, execution preview not generated', '处理方式已保存，尚未生成执行预览') : t('from the report', '来自分析报告')}
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
      <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-card px-3 py-2.5 sm:hidden">
        <div>
          <div className="text-sm font-semibold">{t(`${formatInt(findings.length)} issues found`, `发现 ${formatInt(findings.length)} 个问题`)}</div>
          <div className="mt-0.5 text-xs text-muted-foreground">{blocking ? t(`${formatInt(blocking)} affect release`, `其中 ${formatInt(blocking)} 个会影响交付`) : t('None affect release', '当前没有问题影响交付')}</div>
        </div>
        {run.report.release_status ? <span className={cn('shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold', run.report.release_status === 'BLOCKED' ? 'bg-blocker-tint text-blocker' : 'bg-policy-tint text-policy')}>{label('release_status', run.report.release_status, language)}</span> : null}
      </div>

      <div className="hidden flex-wrap items-center gap-x-4 gap-y-1.5 rounded-md border border-border bg-card px-3 py-1.5 sm:flex">
        <Stat k={t('findings', '问题')} v={formatInt(findings.length)} />
        <Stat k={t('affect release', '影响交付')} v={formatInt(blocking)} tone={blocking ? 'blocker' : 'muted'} />
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
            <Stat k={t('release', '交付状态')} v={label('release_status', run.report.release_status, language)} tone={run.report.release_status === 'BLOCKED' ? 'blocker' : run.report.release_status === 'PASS' ? 'policy' : undefined} />
          </>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div role="tablist" aria-label={t('Filter issues', '筛选问题')} className="flex w-full flex-nowrap items-center gap-1 overflow-x-auto pb-1 sm:w-auto sm:flex-wrap sm:overflow-visible sm:pb-0">
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
                className={cn('inline-flex min-h-9 flex-none items-center gap-1.5 rounded-full border px-3 text-xs transition-colors sm:min-h-6 sm:rounded-md sm:px-2', active ? 'border-foreground bg-foreground text-background' : 'border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground')}
              >
                {modeFilterLabel(entry, language)}
                <span className="mono">{formatInt(count)}</span>
              </button>
            );
          })}
        </div>
        <span className="text-[11px] text-muted-foreground sm:hidden">{t('Open an issue to review evidence and next steps', '点开问题，查看依据和处理建议')}</span>
        <span className="hidden text-[11px] text-muted-foreground sm:inline">{t('Click a row to inspect · ↑ ↓ to move', '点击一行查看详情 · ↑ ↓ 切换')}</span>
      </div>

      <ul className="flex flex-col gap-2 sm:hidden" aria-label={t('Issues', '问题列表')}>
        {visible.length === 0 ? (
          <li className="rounded-xl border border-border bg-card px-4 py-8 text-center text-sm text-muted-foreground">{findings.length === 0 ? t('No issues found', '没有发现需要关注的问题') : t('No issues match this filter', '这个筛选条件下没有问题')}</li>
        ) : (
          visible.map((finding) => {
            const disposition = dispositionOf(finding, run, language);
            return (
              <li key={finding.finding_id}>
                <button
                  type="button"
                  onClick={() => setSelectedFindingId(finding.finding_id)}
                  className={cn('flex min-h-28 w-full flex-col gap-2 rounded-xl border bg-card px-4 py-3 text-left transition-colors', selectedFindingId === finding.finding_id ? 'border-policy bg-policy-tint/30' : 'border-border active:bg-muted')}
                >
                  <span className="flex w-full items-start justify-between gap-3">
                    <span className="min-w-0 text-[15px] leading-5 font-semibold">{findingDisplayTitle(finding, language)}</span>
                    <ChevronRight aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  </span>
                  <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs">
                    <RiskDot value={finding.risk_level} />
                    {finding.blocking ? <span className="font-medium text-blocker">{t('Affects release', '影响交付')}</span> : null}
                    {finding.column ? <span className="mono text-muted-foreground">{finding.column}</span> : null}
                    <span className="text-muted-foreground">
                      {formatInt(finding.affected_record_count)} {t('records', '条记录')}
                    </span>
                  </span>
                  <span className="flex w-full items-center justify-between gap-3 border-t border-black/7 pt-2 text-xs">
                    <span className="text-muted-foreground">{label('authorization_mode', finding.authorization_mode, language)}</span>
                    <span className={cn(disposition.tone === 'blocker' && 'text-blocker', disposition.tone === 'policy' && 'text-policy', disposition.tone === 'review' && 'text-review')}>{disposition.text}</span>
                  </span>
                </button>
              </li>
            );
          })
        )}
      </ul>

      <DataTable
        columns={columns}
        rows={visible}
        rowKey={(row) => row.finding_id}
        onRowClick={(row) => setSelectedFindingId(row.finding_id)}
        selectedKey={selectedFindingId}
        emptyTitle={findings.length === 0 ? t('No issues found', '没有发现需要关注的问题') : t('No issues match the filter', '这个筛选条件下没有问题')}
        emptyDescription={findings.length === 0 ? t('No issues were found under the current release rules.', '按照当前发布规则，这份数据没有需要关注的问题。') : undefined}
        ariaLabel={t('Issues', '问题列表')}
        className="hidden sm:block"
        tableClassName="[&_td]:px-1.5 [&_th]:px-1.5"
      />
    </div>
  );
}
