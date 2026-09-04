'use client';

import { HashChip, LifecyclePill, Pill, ReleaseStatusPill } from '@/components/datapilot';
import { formatInt, formatScore } from '@/lib/format';
import { useLanguage } from '@/lib/language';
import { label } from '@/lib/labels';
import type { AICallRecord, Finding } from '@/lib/types';

import { useWorkspace } from '../workspace-context';

export type AiCounters = {
  proposed: number;
  abstained: number;
  rejected: number;
};

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
    <header className="mx-3 mt-3 mb-3 rounded-2xl border border-black/8 bg-white px-4 py-4 shadow-[0_12px_36px_rgba(16,35,30,0.04)] sm:mx-5 sm:px-5">
      <div className="flex flex-col gap-3 md:hidden">
        <div className="flex min-w-0 items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[11px] text-muted-foreground">{t('Current analysis', '当前分析')}</div>
            <div className="mt-0.5 truncate text-sm font-semibold" title={run?.source_name ?? runId}>
              {run?.source_name ?? '—'}
            </div>
          </div>
          {run ? <LifecyclePill value={run.lifecycle} /> : null}
        </div>

        <div className="flex items-end justify-between gap-4 border-t border-black/7 pt-3">
          <div>
            <div className="text-[11px] text-muted-foreground">{t('Data quality', '数据质量')}</div>
            <div className="mt-1 flex items-baseline gap-1.5">
              <span className="mono text-3xl font-semibold leading-none tracking-[-0.04em]">{report ? formatScore(report.profile.overall_score) : '—'}</span>
              <span className="text-xs text-muted-foreground">/ 100</span>
            </div>
          </div>
          <ReleaseStatusPill value={run?.execution?.release_manifest.release_status ?? report?.release_status ?? null} />
        </div>

        <div className="grid grid-cols-3 gap-2 rounded-xl bg-[#f5f8f6] px-3 py-2.5">
          <Count k={t('records', '记录')} v={report ? formatInt(report.profile.record_count) : '—'} />
          <Count k={t('issues', '问题')} v={report ? formatInt(findings.length) : '—'} />
          <Count k={t('need action', '需处理')} v={report ? formatInt(blocking) : '—'} />
        </div>

        <details className="group border-t border-black/7 pt-2">
          <summary className="flex min-h-8 cursor-pointer list-none items-center justify-between text-xs font-medium text-policy marker:hidden">
            <span>{t('View analysis details', '查看分析信息')}</span>
            <span className="group-open:hidden">+</span>
            <span className="hidden group-open:inline">−</span>
          </summary>
          <div className="mt-2 flex flex-wrap items-center gap-2 rounded-xl border border-black/7 bg-[#fbfcfa] p-3">
            <HashChip value={runId} label={t('run', '运行')} length={10} />
            <Pill variant="neutral" className="mono">
              r{run ? formatInt(run.run_revision) : '—'}
            </Pill>
            {report ? (
              <Pill variant="neutral" className="mono">
                {report.profile.source_encoding}
              </Pill>
            ) : null}
            {run && report ? (
              observational ? (
                <Pill variant="neutral">{t('Quick scan only', '本次为快速扫描')}</Pill>
              ) : (
                <Pill variant="policy" title={contract ? `${contract.id}@${contract.version} · ${contract.hash}` : undefined}>
                  {t('Release rules loaded', '已加载发布规则')}
                </Pill>
              )
            ) : null}
            {report ? <HashChip value={report.profile.dataset_hash} label={t('dataset', '数据集')} /> : null}
            <span className="inline-flex items-center gap-2 text-[11px] text-muted-foreground">
              <Pill variant="ai">AI</Pill>
              {t(`${formatInt(ai.proposed)} suggestions · ${formatInt(ai.abstained)} withheld · ${formatInt(ai.rejected)} failed checks`, `${formatInt(ai.proposed)} 条建议 · ${formatInt(ai.abstained)} 条暂不判断 · ${formatInt(ai.rejected)} 条未通过校验`)}
            </span>
          </div>
        </details>
      </div>

      <div className="hidden flex-wrap items-center gap-x-5 gap-y-2.5 md:flex">
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
              <Pill variant="neutral" title={t('No release rules: quick scan only', '未设置发布规则：本次只做快速扫描')}>
                {t('Quick scan', '快速扫描')}
              </Pill>
            ) : (
              <Pill variant="policy" title={contract ? `${contract.id}@${contract.version} · ${contract.hash}` : undefined}>
                {t('Release rules', '发布规则')} · {label('contract_source', contract?.source ?? contractView?.source, language)}
                {contract ? <span className="mono font-normal">{` ${contract.id}@${contract.version}`}</span> : null}
              </Pill>
            )
          ) : null}
          {report ? <HashChip value={report.profile.dataset_hash} label={t('dataset', '数据集')} /> : null}
          {run?.parent_run_id ? <HashChip value={run.parent_run_id} label={t('replay of', '重跑自')} length={12} /> : null}
        </Group>

        <Group title={t('Quality score is not release status: a high score can still be blocked.', '质量分不等于交付状态：高分仍可能暂不可交付。')}>
          <span className="text-[11px] text-muted-foreground">{t('Score', '数据质量')}</span>
          <span className="mono text-2xl font-semibold leading-none tracking-tight">{report ? formatScore(report.profile.overall_score) : '—'}</span>
          <ReleaseStatusPill value={run?.execution?.release_manifest.release_status ?? report?.release_status ?? null} />
        </Group>

        <Group>
          <Count k={t('records', '记录')} v={report ? formatInt(report.profile.record_count) : '—'} />
          <Count k={t('columns', '字段')} v={report ? formatInt(report.profile.column_count) : '—'} />
          <Count k={t('findings', '问题')} v={report ? `${formatInt(findings.length)}${blocking ? ` · ${t('need action', '需处理')} ${formatInt(blocking)}` : ''}` : '—'} />
        </Group>

        <Group title={t('AI suggestions / withheld judgments / evidence-check failures', 'AI 建议 / 暂不判断 / 证据校验未通过')}>
          <Pill variant="ai">AI</Pill>
          <Count k={t('suggestions', '建议')} v={formatInt(ai.proposed)} />
          <Count k={t('withheld', '暂不判断')} v={formatInt(ai.abstained)} />
          <Count k={t('failed checks', '校验未通过')} v={formatInt(ai.rejected)} />
        </Group>
      </div>
    </header>
  );
}
