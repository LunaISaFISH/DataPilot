'use client';

import { Pill, ProvenanceMark, type Provenance } from '@/components/datapilot';
import { formatTime } from '@/lib/format';
import { pick, useLanguage } from '@/lib/language';
import { label } from '@/lib/labels';
import type { AICallRecord, Finding, RunEvent } from '@/lib/types';

import { asString } from './helpers';

const FALLBACK_STATUSES = new Set(['timeout', 'error', 'refusal', 'rejected_by_grounding', 'fallback_deterministic']);

/** The SEMANTIC_ANALYSIS event that announced a fallback, if the pipeline emitted one. */
function fallbackEvent(events: RunEvent[]): RunEvent | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.stage === 'SEMANTIC_ANALYSIS' && typeof event.detail.fallback_reason === 'string') return event;
  }
  return null;
}

/**
 * 确定性回退 card: shown when the finding has no model proposal or its proposal came from the
 * deterministic provider. States why, from the ledger status or the pipeline event — never
 * presenting the deterministic result as AI output.
 */
export function DeterministicCard({ finding, record, events, semantic }: {
  finding: Finding;
  record: AICallRecord | null;
  events: RunEvent[];
  /** True when the finding is a SEM finding (a model call was expected). */
  semantic: boolean;
}) {
  const { t, language } = useLanguage();
  const proposal = finding.proposal;
  const event = fallbackEvent(events);
  const eventReason = event ? asString(event.detail.fallback_reason) : null;
  const status = record?.status ?? null;

  const provenance: Provenance = proposal
    ? {
        provider: proposal.provider,
        status: status ?? undefined,
        model: proposal.model,
        prompt_version: proposal.prompt_version,
        input_hash: proposal.input_hash,
        grounding: proposal.grounding,
        ledger_call_id: proposal.ledger_call_id,
        reason: proposal.abstain_reason,
      }
    : { provider: 'deterministic' };

  let reasonZh: string;
  let reasonEn: string;
  if (status && FALLBACK_STATUSES.has(status)) {
    reasonZh = `模型调用状态为「${label('ai_status', status, 'zh')}」，引擎改用确定性归一化结果。`;
    reasonEn = `The model call ended with status “${label('ai_status', status, 'en')}”; the engine used its deterministic normalisation instead.`;
  } else if (eventReason) {
    reasonZh = `流水线在语义分析阶段报告 AI 不可用（${eventReason}），全部 SEM 提议由确定性规则生成。`;
    reasonEn = `The pipeline reported AI unavailable during semantic analysis (${eventReason}); every SEM proposal came from deterministic rules.`;
  } else if (semantic && proposal && proposal.provider !== 'anthropic') {
    reasonZh = `提议由 ${label('provider', proposal.provider, 'zh')} 生成（${proposal.model}），未调用模型。`;
    reasonEn = `Proposal produced by ${label('provider', proposal.provider, 'en')} (${proposal.model}); no model was called.`;
  } else if (semantic) {
    reasonZh = '本问题没有可用的模型提议记录；引擎按确定性规则评估。';
    reasonEn = 'No model proposal is recorded for this finding; the engine assessed it deterministically.';
  } else {
    reasonZh = '该类问题由确定性检测器直接产生（重复、别名、格式、缺失、敏感模式），不涉及模型。';
    reasonEn = 'This finding family is produced directly by deterministic detectors (duplicates, aliases, formats, missing, sensitive patterns); no model is involved.';
  }

  return (
    <div className="flex flex-col gap-2 rounded-md border border-border p-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <ProvenanceMark provenance={provenance} />
        {status ? <Pill variant={FALLBACK_STATUSES.has(status) ? 'blocker' : 'neutral'}>{label('ai_status', status, language)}</Pill> : null}
        {finding.proposed_action ? (
          <span className="text-xs text-muted-foreground">
            {t('Proposed action', '提议动作')} · <span className="mono">{finding.proposed_action}</span>
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">{t('No executable proposal', '无可执行提议')}</span>
        )}
      </div>
      <p className="text-xs leading-4">{pick(language, reasonZh, reasonEn)}</p>
      {event ? (
        <p className="mono text-[11px] text-muted-foreground" suppressHydrationWarning>
          {formatTime(event.ts)} · {event.stage} · {pick(language, event.message_zh, event.message_en)}
        </p>
      ) : null}
      {proposal?.mapping && Object.keys(proposal.mapping).length > 0 ? (
        <div className="dp-table-wrap">
          <table className="dp-table">
            <thead>
              <tr>
                <th>{t('Source', '来源值')}</th>
                <th>{t('Target', '目标值')}</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(proposal.mapping).map(([source, target]) => (
                <tr key={source}>
                  <td className="mono text-xs">{source}</td>
                  <td className="mono text-xs">{target}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
