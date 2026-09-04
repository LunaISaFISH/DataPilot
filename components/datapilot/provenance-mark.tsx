'use client';

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { formatInt, formatMs, shortHash } from '@/lib/format';
import { useLanguage } from '@/lib/language';
import { label } from '@/lib/labels';
import type { AICallRecord, AIProposalSummary, AIStatus, GroundingResult, ProviderName } from '@/lib/types';
import { cn } from '@/lib/utils';

export type Provenance = {
  provider: ProviderName;
  status?: AIStatus | null;
  model?: string | null;
  prompt_version?: string | null;
  input_hash?: string | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_tokens?: number | null;
  latency_ms?: number | null;
  grounding?: GroundingResult | null;
  /** Why a deterministic result was produced (e.g. abstain reason, fallback reason). */
  reason?: string | null;
  ledger_call_id?: string | null;
};

export function provenanceFromRecord(record: AICallRecord): Provenance {
  return {
    provider: record.provider,
    status: record.status,
    model: record.model_served ?? record.model_requested,
    prompt_version: record.prompt_version,
    input_hash: record.input_hash,
    input_tokens: record.input_tokens,
    output_tokens: record.output_tokens,
    cache_read_tokens: record.cache_read_tokens,
    latency_ms: record.latency_ms,
    grounding: record.grounding,
    ledger_call_id: record.call_id,
  };
}

export function provenanceFromProposal(proposal: AIProposalSummary): Provenance {
  return {
    provider: proposal.provider,
    status: proposal.abstained ? 'abstained' : proposal.grounding.valid ? 'ok' : 'rejected_by_grounding',
    model: proposal.model,
    prompt_version: proposal.prompt_version,
    input_hash: proposal.input_hash,
    grounding: proposal.grounding,
    reason: proposal.abstain_reason,
    ledger_call_id: proposal.ledger_call_id,
  };
}

/** True only when the element was actually produced by the model and accepted. */
export function isAIDerived(p: Provenance): boolean {
  if (p.provider !== 'anthropic') return false;
  return p.status === undefined || p.status === null || p.status === 'ok' || p.status === 'abstained';
}

export type ProvenanceMarkProps = {
  provenance: Provenance;
  className?: string;
  /** Show the model name next to the mark. */
  showModel?: boolean;
};

function Row({ k, v, mono = false }: { k: string; v: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-0.5">
      <dt className="shrink-0 text-muted-foreground">{k}</dt>
      <dd className={cn('min-w-0 truncate text-right', mono && 'mono')}>{v}</dd>
    </div>
  );
}

/**
 * Violet `AI` mark with a provenance popover for model-produced elements, or a grey 确定性 mark
 * with the reason for deterministic results. The two are never mixed.
 */
export function ProvenanceMark({ provenance, className, showModel = false }: ProvenanceMarkProps) {
  const { t, language } = useLanguage();
  const ai = isAIDerived(provenance);
  const grounding = provenance.grounding;

  return (
    <Popover>
      <PopoverTrigger
        className={cn('pill cursor-pointer', ai ? 'pill-ai' : 'pill-neutral', className)}
        aria-label={ai ? t('AI provenance', 'AI 来源信息') : t('Rule-based result', '规则判断结果')}
      >
        {ai ? 'AI' : t('Rule-based', '规则判断')}
        {showModel && ai && provenance.model ? <span className="font-normal opacity-80">{provenance.model}</span> : null}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 text-xs">
        <div className="flex items-center justify-between">
          <span className="font-semibold">{ai ? t('AI provenance', 'AI 来源') : t('Rule-based result', '规则判断结果')}</span>
          <span className={cn('pill', ai ? 'pill-ai' : 'pill-neutral')}>
            {label('provider', provenance.provider, language)}
          </span>
        </div>
        <dl className="data-dense divide-y divide-border">
          {provenance.status ? <Row k={t('Status', '状态')} v={label('ai_status', provenance.status, language)} /> : null}
          {provenance.model ? <Row k={t('Model', '模型')} v={provenance.model} mono /> : null}
          {provenance.prompt_version ? <Row k={t('Prompt version', '提示词版本')} v={provenance.prompt_version} mono /> : null}
          {provenance.input_hash ? (
            <Row k={t('Input hash', '输入哈希')} v={<span title={provenance.input_hash}>{shortHash(provenance.input_hash)}</span>} mono />
          ) : null}
          {provenance.input_tokens !== undefined && provenance.input_tokens !== null ? (
            <Row
              k={t('Tokens in / out / cached', 'Token 输入 / 输出 / 缓存')}
              v={`${formatInt(provenance.input_tokens)} / ${formatInt(provenance.output_tokens)} / ${formatInt(provenance.cache_read_tokens)}`}
              mono
            />
          ) : null}
          {provenance.latency_ms !== undefined && provenance.latency_ms !== null ? (
            <Row k={t('Latency', '延迟')} v={formatMs(provenance.latency_ms)} mono />
          ) : null}
          {grounding ? (
            <Row
              k={t('Grounding', '证据校验')}
              v={
                <span className={grounding.valid ? 'text-policy' : 'text-blocker'}>
                  {grounding.valid ? t('Passed', '通过') : t('Rejected', '拦截')}
                  {grounding.affected_record_count ? ` · ${formatInt(grounding.affected_record_count)}` : ''}
                </span>
              }
            />
          ) : null}
          {provenance.ledger_call_id ? (
            <Row k={t('Ledger call', '调用记录')} v={shortHash(provenance.ledger_call_id, 12)} mono />
          ) : null}
        </dl>
        {grounding && grounding.reason_codes.length > 0 ? (
          <ul className="flex flex-wrap gap-1">
            {grounding.reason_codes.map((code) => (
              <li key={code} className="pill pill-blocker" title={code}>
                {label('grounding_reason', code, language)}
              </li>
            ))}
          </ul>
        ) : null}
        {!ai ? (
          <p className="text-muted-foreground">
            {provenance.reason ||
              t(
                'Produced by deterministic rules; no model output was used.',
                '由固定规则生成，没有使用模型输出。',
              )}
          </p>
        ) : provenance.reason ? (
          <p className="text-muted-foreground">{provenance.reason}</p>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
