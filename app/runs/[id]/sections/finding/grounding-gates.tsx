'use client';

import { formatInt } from '@/lib/format';
import { useLanguage } from '@/lib/language';
import { label, labelKeys } from '@/lib/labels';
import type { GroundingResult } from '@/lib/types';
import { cn } from '@/lib/utils';

import { asNumberMap, asString, asStringList, asStringMap } from './helpers';

/** Gates the semantic validator applies (ai/grounding.py `validate_proposal`), in its order. */
export const SEMANTIC_GROUNDING_CODES: readonly string[] = [
  'UNKNOWN_FINDING',
  'UNKNOWN_COLUMN',
  'STALE_OR_UNKNOWN_INPUT',
  'HALLUCINATED_SOURCE_VALUE',
  'UNKNOWN_CANONICAL_TARGET',
  'UNKNOWN_EVIDENCE_REFERENCE',
  'AMBIGUITY_REGISTRY_HIT',
  'UNSUPPORTED_ACTION',
  'ABSTENTION_WITH_MAPPING',
  'SCHEMA_VIOLATION',
];

function diff(a: string[], b: string[]): string[] {
  const set = new Set(b);
  return a.filter((entry) => !set.has(entry));
}

function intersect(a: string[], b: string[]): string[] {
  const set = new Set(b);
  return a.filter((entry) => set.has(entry));
}

/**
 * The offending value for a present reason code, computed by comparing the exact request the
 * ledger recorded with the proposal the validator judged. Returns null when the two payloads are
 * not available (the row then shows the code alone).
 */
export function offendingDetail(code: string, request: Record<string, unknown> | null, proposal: Record<string, unknown> | null): string | null {
  if (!request || !proposal) return null;
  const mapping = asStringMap(proposal.mapping);
  const sources = Object.keys(mapping);
  const targets = Object.values(mapping);
  switch (code) {
    case 'UNKNOWN_FINDING':
      return `${asString(proposal.finding_id) ?? '∅'} ≠ ${asString(request.finding_id) ?? '∅'}`;
    case 'UNKNOWN_COLUMN':
      return `${asString(proposal.column) ?? '∅'} ≠ ${asString(request.column) ?? '∅'}`;
    case 'STALE_OR_UNKNOWN_INPUT':
      return asString(proposal.input_hash) ?? null;
    case 'HALLUCINATED_SOURCE_VALUE':
      return diff(sources, Object.keys(asNumberMap(request.candidate_counts))).join(', ') || null;
    case 'UNKNOWN_CANONICAL_TARGET':
      return diff(targets, asStringList(request.canonical_vocabulary)).join(', ') || null;
    case 'UNKNOWN_EVIDENCE_REFERENCE':
      return diff(asStringList(proposal.evidence_refs), asStringList(request.evidence_refs)).join(', ') || null;
    case 'AMBIGUITY_REGISTRY_HIT':
      return intersect(sources, asStringList(request.ambiguity_tokens)).join(', ') || null;
    case 'UNSUPPORTED_ACTION':
      return asString(proposal.proposed_action) ?? JSON.stringify(proposal.proposed_action ?? null);
    case 'ABSTENTION_WITH_MAPPING':
      return sources.length > 0 ? `abstained=true · mapping: ${sources.length}` : null;
    default:
      return null;
  }
}

/** Model-side record count, when the response carried one; the engine never trusts it. */
export function modelRecordCount(response: Record<string, unknown> | null): number | null {
  if (!response) return null;
  const candidates = ['affected_record_count', 'record_count', 'affected_records'];
  for (const key of candidates) {
    const value = response[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

export type GroundingGatesProps = {
  grounding: GroundingResult | null;
  /** The recorded request payload (ledger `request_payload`), used to name the offending value. */
  request: Record<string, unknown> | null;
  /** The proposal the validator judged: `response_payload`, or a tampered raw dict. */
  proposal: Record<string, unknown> | null;
  /** Model-provided record count, if any; compared with the engine's recount. */
  modelCount?: number | null;
  /** Hide the non-semantic codes group (already collapsed by default). */
  compact?: boolean;
};

/**
 * 接地校验: every grounding reason code as a row — green when absent, red with the offending
 * value when present — plus the engine's recomputed record count next to the model's claim.
 */
export function GroundingGates({ grounding, request, proposal, modelCount = null, compact = false }: GroundingGatesProps) {
  const { t, language } = useLanguage();
  if (!grounding) {
    return <p className="text-xs text-muted-foreground">{t('No grounding result recorded for this call.', '此次调用没有记录接地校验结果。')}</p>;
  }
  const present = new Set(grounding.reason_codes);
  const known = new Set<string>([...SEMANTIC_GROUNDING_CODES, ...labelKeys('grounding_reason')]);
  const extra = grounding.reason_codes.filter((code) => !known.has(code));
  const semanticRows = [...SEMANTIC_GROUNDING_CODES, ...extra];
  const otherRows = labelKeys('grounding_reason').filter((code) => !SEMANTIC_GROUNDING_CODES.includes(code) && code !== 'UNKNOWN_EVIDENCE');
  const engineCount = grounding.affected_record_count;

  const row = (code: string) => {
    const hit = present.has(code);
    const detail = hit ? offendingDetail(code, request, proposal) : null;
    return (
      <li key={code} className={cn('grid grid-cols-[14px_minmax(0,1fr)] items-start gap-x-2 px-2 py-1', hit && 'bg-blocker-tint')}>
        <span className={cn('mono text-sm leading-4', hit ? 'text-blocker' : 'text-policy')} aria-hidden="true">
          {hit ? '✗' : '✓'}
        </span>
        <span className="flex min-w-0 flex-col">
          <span className="flex flex-wrap items-baseline gap-x-2">
            <span className="mono text-[11px]">{code}</span>
            <span className={cn('text-xs', hit ? 'text-blocker' : 'text-muted-foreground')}>{label('grounding_reason', code, language)}</span>
          </span>
          {hit ? (
            <span className="mono text-[11px] break-all text-blocker">
              {detail ?? t('offending value not recoverable from the recorded payloads', '无法从记录的载荷中还原违规值')}
            </span>
          ) : null}
        </span>
      </li>
    );
  };

  return (
    <div className="flex flex-col gap-2">
      <div className={cn('flex items-center justify-between rounded-md border px-2 py-1 text-xs', grounding.valid ? 'border-policy/30 bg-policy-tint text-policy' : 'border-blocker/30 bg-blocker-tint text-blocker')}>
        <span className="font-semibold">{grounding.valid ? t('Grounding passed', '接地校验通过') : t('Grounding rejected', '接地校验拒绝')}</span>
        <span className="mono">
          {formatInt(grounding.reason_codes.length)} / {formatInt(semanticRows.length)} {t('gates hit', '门被触发')}
        </span>
      </div>
      <ul className="divide-y divide-border overflow-hidden rounded-md border border-border">{semanticRows.map(row)}</ul>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-xs">
        <dt className="text-muted-foreground">{t('Engine recount', '引擎重算记录数')}</dt>
        <dd className="mono">{formatInt(engineCount)}</dd>
        <dt className="text-muted-foreground">{t('Model claim', '模型声明记录数')}</dt>
        <dd className={cn('mono', modelCount === null && 'text-muted-foreground')}>
          {modelCount === null ? t('model did not provide a record count', '模型未提供记录数') : formatInt(modelCount)}
          {modelCount !== null && modelCount !== engineCount ? <span className="ml-2 text-blocker">{t('≠ engine', '≠ 引擎')}</span> : null}
        </dd>
      </dl>
      {!compact ? (
        <details className="rounded-md border border-border">
          <summary className="cursor-pointer px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted">
            {t('Codes used by the other tasks (contract draft, brief)', '其他任务使用的原因码（契约起草、简报）')} · {formatInt(otherRows.length)}
          </summary>
          <ul className="divide-y divide-border border-t border-border">{otherRows.map(row)}</ul>
        </details>
      ) : null}
    </div>
  );
}
