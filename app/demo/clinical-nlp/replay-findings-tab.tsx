'use client';

import { X } from 'lucide-react';
import { useState } from 'react';

import { AuthModePill, DataTable, EmptyState, KeyValueList, PanelSection, Pill, ProvenanceMark, RiskPill, type DataTableColumn, type KeyValueItem } from '@/components/datapilot';
import { Button } from '@/components/ui/button';
import { formatInt } from '@/lib/format';
import { pick, useLanguage } from '@/lib/language';
import { findingFamilyLabel, label } from '@/lib/labels';
import type { EvidenceSignal } from '@/lib/types';

import type { ReplayBundle, ReplayFinding } from './replay-data';
import { EvidenceGlyphs, IntOrUnavailable, Unavailable, provenanceFromReplayProposal } from './replay-ui';

function detailValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.length <= 6 ? JSON.stringify(value) : `[${value.length}]`;
  return JSON.stringify(value);
}

function MappingTable({ mapping, counts }: { mapping: Record<string, string>; counts: Record<string, unknown> | null }) {
  const { t } = useLanguage();
  const rows = Object.entries(mapping).map(([from, to]) => ({ from, to, count: counts && typeof counts[from] === 'number' ? (counts[from] as number) : null }));
  const columns: DataTableColumn<(typeof rows)[number]>[] = [
    { key: 'from', header: t('Observed value', '观测值'), render: (row) => <span className="mono">{JSON.stringify(row.from)}</span> },
    { key: 'to', header: t('Canonical target', '规范目标'), render: (row) => <span className="mono">{row.to}</span> },
    { key: 'count', header: t('Records', '记录'), align: 'right', render: (row) => (row.count === null ? '—' : formatInt(row.count)) },
  ];
  return <DataTable columns={columns} rows={rows} rowKey={(row) => row.from} ariaLabel={t('Proposed mapping', '提议映射')} />;
}

function FindingDetail({ finding, disposition, onClose }: { finding: ReplayFinding; disposition: string | null; onClose: () => void }) {
  const { t, language } = useLanguage();
  const proposal = finding.proposal;
  const details = finding.details;
  const mapping = proposal?.mapping ?? (typeof details.mapping === 'object' && details.mapping !== null && !Array.isArray(details.mapping) ? (details.mapping as Record<string, string>) : null);
  const observedCounts = typeof details.observed_counts === 'object' && details.observed_counts !== null && !Array.isArray(details.observed_counts) ? (details.observed_counts as Record<string, unknown>) : null;
  const otherDetails = Object.entries(details).filter(([key]) => key !== 'mapping' && key !== 'observed_counts');

  const evidenceColumns: DataTableColumn<EvidenceSignal>[] = [
    { key: 'signal', header: t('Signal', '信号'), render: (row) => <span className="mono text-xs">{row.signal}</span> },
    {
      key: 'status',
      header: t('Result', '结果'),
      render: (row) => (
        <Pill variant={row.status === 'PASS' ? 'policy' : row.status === 'FAIL' ? 'blocker' : 'neutral'}>{label('evidence_status', row.status, language)}</Pill>
      ),
    },
    { key: 'explanation', header: t('Explanation', '说明'), render: (row) => <span className="text-xs">{pick(language, row.explanation_zh, row.explanation_en) || '—'}</span> },
    { key: 'evidence_ref', header: t('Ref', '引用'), render: (row) => <span className="mono text-xs">{row.evidence_ref || '—'}</span> },
  ];

  const facts: KeyValueItem[] = [
    { key: 'type', label: t('Type', '类型'), value: <span className="mono text-xs">{finding.finding_type ?? '—'}</span> },
    { key: 'column', label: t('Column', '字段'), value: <span className="mono text-xs">{finding.column ?? '—'}</span> },
    { key: 'risk', label: t('Risk', '风险'), value: <RiskPill value={finding.risk_level ?? ''} /> },
    { key: 'auth', label: t('Authorization mode', '授权模式'), value: finding.authorization_mode ? <AuthModePill value={finding.authorization_mode} /> : <Unavailable /> },
    { key: 'action', label: t('Proposed action', '提议动作'), value: finding.proposed_action ? label('allowed_action', finding.proposed_action, language) : t('None', '无') },
    { key: 'records', label: t('Affected records', '受影响记录'), value: <IntOrUnavailable value={finding.affected_record_count} /> },
    { key: 'cells', label: t('Affected cells', '受影响单元格'), value: <IntOrUnavailable value={finding.affected_cell_count} /> },
    { key: 'blocking', label: t('Blocking', '阻断'), value: finding.blocking === null ? <Unavailable /> : finding.blocking ? t('Yes', '是') : t('No', '否') },
    {
      key: 'disposition',
      label: t('Recorded disposition', '已记录处置'),
      value: disposition ? <Pill variant="neutral">{label('disposition', disposition, language)}</Pill> : <Unavailable reason={t('no execution record', '无执行记录')} />,
    },
    {
      key: 'outcomes',
      label: t('Allowed outcomes', '允许的处置'),
      value: finding.allowed_outcomes.length === 0 ? <Unavailable /> : finding.allowed_outcomes.map((outcome) => label('decision_outcome', outcome, language)).join(' · '),
    },
  ];

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="mono text-xs">{finding.finding_id}</span>
            <Pill variant="neutral">{findingFamilyLabel(finding.finding_id, language)}</Pill>
          </div>
          <h3 className="mt-1 text-[13px] font-semibold leading-5">{pick(language, finding.title_zh, finding.title_en) || finding.finding_id}</h3>
          {pick(language, finding.explanation_zh, finding.explanation_en) ? (
            <p className="mt-1 text-xs leading-4 text-muted-foreground">{pick(language, finding.explanation_zh, finding.explanation_en)}</p>
          ) : null}
        </div>
        <Button variant="ghost" size="icon" className="size-7 shrink-0" onClick={onClose} aria-label={t('Close', '关闭')}>
          <X aria-hidden="true" className="size-4" />
        </Button>
      </div>

      <KeyValueList items={facts} />

      <PanelSection id="replay-evidence" title={t('Evidence', '证据')} flush>
        <DataTable columns={evidenceColumns} rows={finding.evidence_signals} rowKey={(row) => `${row.signal}-${row.evidence_ref}`} className="rounded-none border-0" emptyTitle={t('No evidence signals recorded', '未记录证据信号')} />
      </PanelSection>

      <PanelSection
        id="replay-proposal"
        title={t('Recorded proposal', '已记录的提议')}
        actions={proposal ? <ProvenanceMark provenance={provenanceFromReplayProposal(proposal)} showModel /> : null}
        description={
          proposal
            ? proposal.abstained
              ? t('The model abstained; no mapping was executed from it.', '模型弃权，未据此执行任何映射。')
              : t('Model, prompt version, input hash and grounding are in the mark.', '模型、提示词版本、输入哈希与落地校验见标记。')
            : t('This artifact records no model proposal for the finding; the mapping below, if any, comes from the deterministic detector.', '工件未记录该问题的模型提议；下方映射（如有）来自确定性检测器。')
        }
      >
        {proposal?.abstained && proposal.abstain_reason ? <p className="mb-2 text-xs text-muted-foreground">{proposal.abstain_reason}</p> : null}
        {mapping && Object.keys(mapping).length > 0 ? (
          <MappingTable mapping={mapping} counts={observedCounts} />
        ) : (
          <span className="text-xs text-muted-foreground">{t('No mapping recorded.', '未记录映射。')}</span>
        )}
      </PanelSection>

      {otherDetails.length > 0 ? (
        <PanelSection id="replay-details" title={t('Detector details', '检测器详情')}>
          <KeyValueList items={otherDetails.map(([key, value]) => ({ key, label: <span className="mono text-xs">{key}</span>, value: <span className="mono text-xs break-all">{detailValue(value)}</span> }))} />
        </PanelSection>
      ) : null}

      <PanelSection
        id="replay-records"
        title={t('Affected records', '受影响记录')}
        description={`${formatInt(finding.record_uid_count)} record_uid · ${t('showing', '显示')} ${formatInt(finding.sample_record_uids.length)}`}
      >
        {finding.sample_record_uids.length === 0 ? (
          <Unavailable reason={t('no record uids in this artifact', '工件未包含记录标识')} />
        ) : (
          <ul className="mono grid grid-cols-2 gap-x-3 gap-y-0.5 text-xs">
            {finding.sample_record_uids.map((uid) => (
              <li key={uid} className="truncate" title={uid}>
                {uid}
              </li>
            ))}
          </ul>
        )}
      </PanelSection>
    </div>
  );
}

export function ReplayFindingsTab({ bundle }: { bundle: ReplayBundle }) {
  const { t, language } = useLanguage();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const report = bundle.report;
  if (!report) {
    return <EmptyState title={t('report.json is unavailable', 'report.json 不可用')} />;
  }
  const dispositions = bundle.execution?.dry_run?.finding_dispositions ?? {};
  const findings = report.findings;
  const selected = findings.find((finding) => finding.finding_id === selectedId) ?? null;

  const columns: DataTableColumn<ReplayFinding>[] = [
    { key: 'finding_id', header: 'ID', render: (row) => <span className="mono text-xs">{row.finding_id}</span> },
    {
      key: 'title',
      header: t('Title', '标题'),
      render: (row) => (
        <span className="inline-flex flex-col">
          <span>{pick(language, row.title_zh, row.title_en) || row.finding_id}</span>
          <span className="text-[11px] text-muted-foreground">{findingFamilyLabel(row.finding_id, language)}</span>
        </span>
      ),
    },
    { key: 'column', header: t('Column', '字段'), render: (row) => <span className="mono text-xs">{row.column ?? '—'}</span> },
    { key: 'risk', header: t('Risk', '风险'), render: (row) => <RiskPill value={row.risk_level ?? ''} /> },
    {
      key: 'auth',
      header: t('Authorization', '授权模式'),
      render: (row) => (row.authorization_mode ? <span className="mono text-[11px]" title={label('authorization_mode', row.authorization_mode, language)}>{row.authorization_mode}</span> : '—'),
    },
    { key: 'records', header: t('Records', '记录'), align: 'right', render: (row) => (row.affected_record_count === null ? '—' : formatInt(row.affected_record_count)) },
    { key: 'cells', header: t('Cells', '单元格'), align: 'right', render: (row) => (row.affected_cell_count === null ? '—' : formatInt(row.affected_cell_count)) },
    { key: 'evidence', header: t('Evidence', '证据'), render: (row) => <EvidenceGlyphs signals={row.evidence_signals} /> },
    {
      key: 'source',
      header: t('Proposal source', '提议来源'),
      render: (row) =>
        row.proposal ? (
          <ProvenanceMark provenance={provenanceFromReplayProposal(row.proposal)} />
        ) : row.proposed_action ? (
          <Pill variant="neutral">{t('Deterministic', '确定性')}</Pill>
        ) : (
          <span className="text-muted-foreground">{t('None', '无')}</span>
        ),
    },
    {
      key: 'disposition',
      header: t('Disposition', '处置'),
      render: (row) => {
        const value = dispositions[row.finding_id] ?? row.disposition;
        return value ? <span className="text-xs">{label('disposition', value, language)}</span> : '—';
      },
    },
  ];

  return (
    <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_420px]">
      <PanelSection
        id="replay-findings"
        title={t('Findings', '发现')}
        description={t('Titles and explanations come from the artifact; select a row for evidence and the recorded proposal.', '标题与说明来自工件；选择一行查看证据与已记录的提议。')}
        actions={<span className="mono text-[11px] text-muted-foreground">{formatInt(findings.length)} · {t('blocking', '阻断')} {formatInt(findings.filter((f) => f.blocking === true).length)}</span>}
        flush
      >
        <DataTable
          columns={columns}
          rows={findings}
          rowKey={(row) => row.finding_id}
          onRowClick={(row) => setSelectedId(row.finding_id === selectedId ? null : row.finding_id)}
          selectedKey={selectedId}
          className="rounded-none border-0"
          ariaLabel={t('Findings', '发现')}
          emptyTitle={t('No findings in this artifact', '工件中没有发现')}
        />
      </PanelSection>
      <aside className="panel min-w-0 p-3">
        {selected ? (
          <FindingDetail finding={selected} disposition={dispositions[selected.finding_id] ?? null} onClose={() => setSelectedId(null)} />
        ) : (
          <EmptyState title={t('No finding selected', '未选择发现')} description={t('Select a row to see evidence, the recorded proposal and affected records.', '选择一行查看证据、已记录的提议与受影响记录。')} className="border-0 py-10" />
        )}
      </aside>
    </div>
  );
}
