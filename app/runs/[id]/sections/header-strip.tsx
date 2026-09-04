'use client';

import { HashChip, LifecyclePill, Pill, ReleaseStatusPill } from '@/components/datapilot';
import { formatInt, formatScore } from '@/lib/format';
import { useLanguage } from '@/lib/language';
import { label } from '@/lib/labels';
import type { AICallRecord, Finding } from '@/lib/types';

import { useWorkspace } from '../workspace-context';

export type AiCounters = { proposed: number; abstained: number; rejected: number };

/**
 * 提议 / 弃权 / 被拒 derived from findings[].proposal first (one per finding), then from ledger
 * records not already represented by a finding proposal. Only Anthropic calls count; deterministic
 * fallbacks and red-team tampers are excluded so nothing deterministic is labelled as AI work.
 */
export function aiCounters(findings: Finding[], ledger: AICallRecord[]): AiCounters {
  const counters: AiCounters = { proposed: 0, abstained: 0, rejected: 0 };
  const seen = new Set<string>();
  for (const finding of findings) {
    const proposal = finding.proposal;
    if (!proposal || proposal.provider !== 'anthropic') continue;
    if (proposal.ledger_call_id) seen.add(proposal.ledger_call_id);
    if (proposal.abstained) counters.abstained += 1;
    else if (!proposal.grounding.valid) counters.rejected += 1;
    else counters.proposed += 1;
  }
  for (const record of ledger) {
    if (record.provider !== 'anthropic' || record.task === 'redteam' || seen.has(record.call_id)) continue;
    if (record.status === 'ok' || record.status === 'cached') counters.proposed += 1;
    else if (record.status === 'abstained') counters.abstained += 1;
    else if (record.status === 'rejected_by_grounding') counters.rejected += 1;
  }
  return counters;
}

function Group({ children, title }: { children: React.ReactNode; title?: string }) {
  return (
    <div className="flex min-w-0 max-w-full items-center gap-2 overflow-x-auto whitespace-nowrap" title={title}>
      {children}
    </div>
  );
}

function Count({ k, v }: { k: string; v: string }) {
  return (
    <span className="inline-flex items-baseline gap-1">
      <span className="text-[11px] text-muted-foreground">{k}</span>
      <span className="mono text-xs">{v}</span>
    </span>
  );
}

export function HeaderStrip() {
  const { t, language } = useLanguage();
  const { runId, run, ledger } = useWorkspace();
  const report = run?.report ?? null;
  const findings = report?.findings ?? [];
  const blocking = findings.filter((finding) => finding.blocking).length;
  const ai = aiCounters(findings, ledger);
  const contract = report?.contract ?? null;
  const contractView = run?.contract ?? null;
  const observational = !contractView || contract?.source === 'baseline';

  return (
    <header className="mx-3 mt-3 mb-3 flex flex-wrap items-center gap-x-5 gap-y-2.5 rounded-2xl border border-black/8 bg-white px-4 py-3 shadow-[0_12px_36px_rgba(16,35,30,0.04)] sm:mx-5 sm:px-5">
      <Group>
        <span className="max-w-[28ch] truncate text-[13px] font-semibold" title={run?.source_name ?? runId}>
          {run?.source_name ?? '—'}
        </span>
        <HashChip value={runId} label={t('run', '运行')} length={12} />
        <Pill variant="neutral" className="mono">
          r{run ? formatInt(run.run_revision) : '—'}
        </Pill>
        {run ? <LifecyclePill value={run.lifecycle} /> : null}
      </Group>

      <Group>
        {report ? (
          <Pill variant="neutral" className="mono" title={t('Source encoding', '源文件编码')}>
            {report.profile.source_encoding}
          </Pill>
        ) : null}
        {run && report ? (
          observational ? (
            <Pill variant="neutral" title={t('No contract: observational only', '无契约：仅观测')}>
              {t('Observational', '仅观测')}
            </Pill>
          ) : (
            <Pill variant="policy" title={contract ? `${contract.id}@${contract.version} · ${contract.hash}` : undefined}>
              {t('Contract', '契约')} · {label('contract_source', contract?.source ?? contractView?.source, language)}
              {contract ? <span className="mono font-normal">{` ${contract.id}@${contract.version}`}</span> : null}
            </Pill>
          )
        ) : null}
        {report ? <HashChip value={report.profile.dataset_hash} label={t('dataset', '数据集')} /> : null}
        {run?.parent_run_id ? <HashChip value={run.parent_run_id} label={t('replay of', '重跑自')} length={12} /> : null}
      </Group>

      <Group title={t('Quality score is not release status: a high score can still be blocked.', '质量分不等于发布状态：高分仍可能被阻断。')}>
        <span className="text-[11px] text-muted-foreground">{t('Score', '质量分')}</span>
        <span className="mono text-2xl font-semibold leading-none tracking-tight">
          {report ? formatScore(report.profile.overall_score) : '—'}
        </span>
        <ReleaseStatusPill value={run?.execution?.release_manifest.release_status ?? report?.release_status ?? null} />
      </Group>

      <Group>
        <Count k={t('records', '记录')} v={report ? formatInt(report.profile.record_count) : '—'} />
        <Count k={t('columns', '字段')} v={report ? formatInt(report.profile.column_count) : '—'} />
        <Count
          k={t('findings', '问题')}
          v={report ? `${formatInt(findings.length)}${blocking ? ` · ${t('blocking', '阻断')} ${formatInt(blocking)}` : ''}` : '—'}
        />
      </Group>

      <Group title={t('AI proposals / abstentions / grounding rejections', 'AI 提议 / 弃权 / 被落地校验拦截')}>
        <Pill variant="ai">AI</Pill>
        <Count k={t('proposed', '提议')} v={formatInt(ai.proposed)} />
        <Count k={t('abstained', '弃权')} v={formatInt(ai.abstained)} />
        <Count k={t('rejected', '被拒')} v={formatInt(ai.rejected)} />
      </Group>
    </header>
  );
}
