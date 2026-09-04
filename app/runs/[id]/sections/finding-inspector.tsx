'use client';

import { useState } from 'react';

import { PanelSection, Pill, ProvenanceMark, provenanceFromProposal } from '@/components/datapilot';
import { Button } from '@/components/ui/button';
import { ApiError } from '@/lib/api';
import { formatInt } from '@/lib/format';
import { useLanguage } from '@/lib/language';
import { findingDisplayExplanation, findingDisplayTitle, findingFamilyLabel, label } from '@/lib/labels';

import { useWorkspace } from '../workspace-context';
import { AbstentionCard } from './finding/abstention-card';
import { AiEnvelope } from './finding/ai-envelope';
import { DeterministicCard } from './finding/deterministic-card';
import { EvidenceTable } from './finding/evidence-table';
import { AuthCodeChip, RiskDot, Stat, dispositionOf, isSemFinding, ledgerRecordFor, proposalSource, redteamRecordsFor } from './finding/helpers';
import { ProposalCard } from './finding/proposal-card';
import { RecordsTable } from './finding/records-table';
import { RedteamPanel } from './finding/redteam-panel';
import { GuardRow } from '@/components/datapilot';

export type FindingInspectorProps = {
  findingId: string;
};

/**
 * Right pane for a selected finding (spec §9.2): header, 证据, 受影响记录, the AI 评估 envelope
 * (发送 / 返回 / 接地校验) with the proposal, abstention or deterministic card, 重新评估, and the
 * 红队 harness. Every number comes from the report, the ledger or a request made here.
 */
export function FindingInspector({ findingId }: FindingInspectorProps) {
  const { t, language } = useLanguage();
  const { run, runId, ledger, events, setSelectedFindingId, rerunSemantic, busy } = useWorkspace();
  const [rerunError, setRerunError] = useState<ApiError | null>(null);
  const [rerunNote, setRerunNote] = useState<string | null>(null);

  const finding = run?.report?.findings.find((entry) => entry.finding_id === findingId) ?? null;

  const close = (
    <Button size="xs" variant="ghost" onClick={() => setSelectedFindingId(null)} aria-label={t('Close inspector', '关闭详情')}>
      {t('Close', '关闭')}
    </Button>
  );

  if (!finding) {
    return (
      <div className="flex flex-col gap-2 p-3">
        <div className="flex items-center justify-between">
          <span className="mono text-xs">{findingId}</span>
          {close}
        </div>
        <p className="text-xs text-muted-foreground">{t('This finding is not in the current report (the run may have been re-analysed).', '当前报告中没有该问题（运行可能已重新分析）。')}</p>
      </div>
    );
  }

  const semantic = isSemFinding(finding.finding_id);
  const record = ledgerRecordFor(finding, ledger);
  const source = proposalSource(finding, record);
  const disposition = dispositionOf(finding, run, language);
  const applied = run?.lifecycle === 'APPLIED';
  const redteamRecords = redteamRecordsFor(finding, ledger);
  const showEnvelope = record !== null && (source === 'ai' || source === 'ai_abstained' || source === 'ai_rejected' || record.provider === 'anthropic');

  const rerun = async () => {
    setRerunError(null);
    setRerunNote(null);
    try {
      const result = await rerunSemantic(finding.finding_id);
      const status = result.finding.proposal ? (result.finding.proposal.abstained ? 'abstained' : result.finding.proposal.grounding.valid ? 'ok' : 'rejected_by_grounding') : null;
      setRerunNote(
        `${t('Re-assessed', '已重新评估')} · ${label('provider', result.finding.proposal?.provider ?? 'deterministic', language)}${status ? ` · ${label('ai_status', status, language)}` : ''}${result.ledger_call_id ? ` · ${t('ledger', '账本')} ${result.ledger_call_id}` : ''}`,
      );
    } catch (reason) {
      if (reason instanceof ApiError) setRerunError(reason);
    }
  };

  return (
    <div className="flex flex-col gap-3 p-3">
      <header className="flex flex-col gap-1.5">
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="flex flex-wrap items-center gap-2">
              <span className="mono text-xs font-semibold">{finding.finding_id}</span>
              <span className="text-[11px] text-muted-foreground">{findingFamilyLabel(finding.finding_id, language)}</span>
              {finding.blocking ? <Pill variant="blocker">{t('Affects release', '影响交付')}</Pill> : null}
            </span>
            <h2 className="text-base leading-6 font-semibold">{findingDisplayTitle(finding, language)}</h2>
          </div>
          {close}
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          <RiskDot value={finding.risk_level} />
          <span className="hidden sm:inline-flex"><AuthCodeChip value={finding.authorization_mode} /></span>
          <span className="text-muted-foreground">{label('authorization_mode', finding.authorization_mode, language)}</span>
          {finding.column ? (
            <Stat k={t('field', '字段')} v={<span className="mono">{finding.column}</span>} />
          ) : null}
          <Stat k={t('records', '记录')} v={formatInt(finding.affected_record_count)} />
          <Stat k={t('cells', '单元格')} v={formatInt(finding.affected_cell_count)} />
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          <Stat k={t('suggested handling', '建议处理')} v={finding.proposed_action ? label('allowed_action', finding.proposed_action, language) : t('none', '暂无')} />
          <Stat k={t('current status', '当前状态')} v={disposition.text} tone={disposition.tone === 'neutral' ? 'muted' : disposition.tone === 'info' ? undefined : disposition.tone} />
          {finding.proposal ? <ProvenanceMark provenance={provenanceFromProposal(finding.proposal)} showModel /> : null}
        </div>
        <p className="text-[13px] leading-5 text-muted-foreground">{findingDisplayExplanation(finding, language)}</p>
        {finding.allowed_outcomes.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
            <span>{t('Available choices', '可选处理方式')}</span>
            {finding.allowed_outcomes.map((outcome) => (
              <Pill key={outcome} variant="neutral" className="font-normal">
                {label('decision_outcome', outcome, language)}
              </Pill>
            ))}
          </div>
        ) : null}
      </header>

      <PanelSection id="finding-evidence" title={t('Evidence', '判断依据')} description={t('Signals recorded for this issue.', '系统据此判断该问题，并保留原始证据编号。')} flush>
        <EvidenceTable signals={finding.evidence_signals} maxHeight={280} />
      </PanelSection>

      <PanelSection
        id="finding-ai"
        title={showEnvelope ? t('AI assessment', 'AI 判断记录') : t('Rule assessment', '规则判断')}
        description={
          showEnvelope
            ? t('Exactly what was sent, what came back, and how it was checked.', '查看 AI 使用了哪些信息、给出什么建议，以及建议是否通过证据校验。')
            : t('A clear rule identified this issue and produced the suggested next step.', '该问题命中了明确规则，系统据此给出处理建议。')
        }
        actions={
          semantic ? (
            <Button size="xs" variant="outline" disabled={applied || busy.rerunSemantic} onClick={() => void rerun()} title={applied ? t('Run already applied', '运行已执行') : undefined}>
              {busy.rerunSemantic ? t('Re-assessing', '正在重新判断') : t('Re-assess', '重新判断')}
            </Button>
          ) : undefined
        }
        bodyClassName="flex flex-col gap-2 p-3"
      >
        {rerunError ? <GuardRow error={rerunError} title={t('Re-assessment refused', '重新评估被拒绝')} onRetry={() => void rerun()} /> : null}
        {rerunNote ? <p className="mono text-[11px] text-muted-foreground">{rerunNote}</p> : null}
        {busy.rerunSemantic ? (
          <p className="mono text-[11px] text-muted-foreground">POST /v1/runs/{runId}/findings/{finding.finding_id}/semantic …</p>
        ) : null}
        {showEnvelope && record ? <AiEnvelope finding={finding} record={record} /> : null}
        {source === 'ai' && finding.proposal ? <ProposalCard finding={finding} record={record} /> : null}
        {source === 'ai_abstained' && finding.proposal ? <AbstentionCard proposal={finding.proposal} record={record} /> : null}
        {source === 'ai_rejected' || source === 'deterministic' || source === 'ineligible' ? (
          <DeterministicCard finding={finding} record={record} events={events} semantic={semantic} />
        ) : null}
      </PanelSection>

      <PanelSection id="finding-records" title={t('Affected records', '相关记录')} description={t('Sample rows from the source, masked by the server.', '以下是源文件中的部分记录；敏感内容已由服务端遮蔽。')}>
        <RecordsTable key={finding.finding_id} runId={runId} findingId={finding.finding_id} affectedRecordCount={finding.affected_record_count} highlightColumn={finding.column} />
      </PanelSection>

      {semantic ? (
        <PanelSection
          id="finding-redteam"
          title={t('Red team', '安全校验演练')}
          description={t('Tamper with the proposal and watch the same validator reject it. Decision state never changes.', '模拟一条被篡改的建议，验证系统能否拦截。演练不会改变当前处理结果。')}
          actions={redteamRecords.length > 0 ? <span className="text-[11px] text-muted-foreground">{formatInt(redteamRecords.length)} {t('ledger records', '条账本记录')}</span> : undefined}
        >
          <RedteamPanel finding={finding} baseRecord={record} />
        </PanelSection>
      ) : null}
    </div>
  );
}
