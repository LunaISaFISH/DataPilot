'use client';

import { useEffect, useState } from 'react';

import { InlineAlert, PanelSection, Pill, ProvenanceMark, provenanceFromRecord } from '@/components/datapilot';
import { Button } from '@/components/ui/button';
import { ApiError, getBrief } from '@/lib/api';
import { formatInt } from '@/lib/format';
import { pick, useLanguage } from '@/lib/language';
import { label } from '@/lib/labels';
import type { AICallRecord, ReleaseBrief } from '@/lib/types';
import { cn } from '@/lib/utils';

import { GuardRow } from '@/components/datapilot';

const BRIEF_POLL_MS = 2000;

export type BriefPanelProps = {
  runId: string;
  /** `run.brief` from RunDetail when the server already stored one. */
  initial: ReleaseBrief | null;
  ledger: AICallRecord[];
  /** Called after a poll settles so the shell can refresh the ledger. */
  onSettled?: () => void;
};

function isPending(brief: ReleaseBrief | null): boolean {
  return brief !== null && brief.status === 'pending';
}

/**
 * AI 发布简报: `GET /brief` (lazily generated once, cached). Every claim is grounded by the
 * server against named facts; unverified claims are struck through with the reason.
 */
export function BriefPanel({ runId, initial, ledger, onSettled }: BriefPanelProps) {
  const { t, language } = useLanguage();
  const [brief, setBrief] = useState<ReleaseBrief | null>(initial);
  const [error, setError] = useState<ApiError | null>(null);
  const [requestCount, setRequestCount] = useState(0);
  const pending = isPending(brief);
  const needsFetch = brief === null;

  useEffect(() => {
    if (!needsFetch && !pending) return;
    let cancelled = false;
    const controller = new AbortController();
    const load = async () => {
      try {
        const result = await getBrief(runId, controller.signal);
        if (cancelled) return;
        setRequestCount((n) => n + 1);
        setBrief(result);
        setError(null);
        if (result.status !== 'pending') onSettled?.();
      } catch (reason) {
        if (cancelled || (reason instanceof DOMException && reason.name === 'AbortError')) return;
        if (reason instanceof ApiError) setError(reason);
      }
    };
    void load();
    const timer = pending ? setInterval(() => void load(), BRIEF_POLL_MS) : null;
    return () => {
      cancelled = true;
      controller.abort();
      if (timer) clearInterval(timer);
    };
  }, [runId, needsFetch, pending, onSettled]);

  const record = brief?.ledger_call_id ? (ledger.find((row) => row.call_id === brief.ledger_call_id) ?? null) : null;
  const provenance = record ? provenanceFromRecord(record) : null;
  const deterministic = record ? record.provider !== 'anthropic' || record.status === 'fallback_deterministic' : false;
  const failed = brief?.status === 'failed' || (record !== null && (record.status === 'error' || record.status === 'timeout' || record.status === 'refusal'));

  const retry = () => {
    setError(null);
    setBrief(null);
  };

  return (
    <PanelSection
      id="release-brief"
      title={
        <span className="inline-flex items-center gap-2">
          {t('AI release brief', 'AI 发布简报')}
          {provenance ? <ProvenanceMark provenance={provenance} showModel /> : null}
        </span>
      }
      description={t(
        'GET /v1/runs/{id}/brief — generated once and cached. Every numeric claim is checked against the manifest and report; unverified claims are struck through.',
        'GET /v1/runs/{id}/brief — 只生成一次并缓存。每条数字性陈述都会与清单和报告核对；未核实的陈述以删除线显示。',
      )}
      actions={
        brief && !pending ? (
          <span className="mono text-xs text-muted-foreground">
            {t('verified', '已核实')} {formatInt(brief.verified_count)} / {formatInt(brief.total_count)}
          </span>
        ) : undefined
      }
    >
      <div className="flex flex-col gap-3">
        {error ? <GuardRow error={error} onRetry={retry} /> : null}
        {!brief && !error ? (
          <p className="text-xs text-muted-foreground">
            GET /v1/runs/{runId}/brief · {t('request in flight', '请求进行中')}
          </p>
        ) : null}
        {pending ? (
          <p className="text-xs text-muted-foreground">
            {t('Brief is being generated on the server; polling every 2 s.', '简报正在服务端生成；每 2 秒轮询一次。')} <span className="mono">{formatInt(requestCount)}</span> {t('requests so far', '次请求')}
          </p>
        ) : null}
        {brief && !pending ? (
          <>
            {failed ? (
              <InlineAlert variant="warning" title={t('Brief unavailable', '简报不可用')}>
                <span className="mono">status: {brief.status}</span>
                {record && record.status !== 'ok' ? ` · ${label('ai_status', record.status, language)} · ${label('provider', record.provider, language)}` : ''}
                {' · '}
                {t('No summary was produced by the model; nothing below is AI text.', '模型未产出摘要；下方没有任何 AI 文本。')}
              </InlineAlert>
            ) : null}
            {deterministic && !failed ? (
              <InlineAlert variant="info" title={t('Deterministic brief', '确定性简报')}>
                {t('The AI provider was not used for this brief; the summary was assembled from the manifest by rules.', '本简报未使用 AI 提供方；摘要由规则从清单中拼装而成。')}
                {record ? ` · ${label('ai_status', record.status, language)}` : ''}
              </InlineAlert>
            ) : null}
            {!record && brief.ledger_call_id ? (
              <p className="text-[11px] text-muted-foreground">
                {t('Ledger call not found locally', '账本中未找到该调用')} <span className="mono">{brief.ledger_call_id}</span>
              </p>
            ) : null}
            {!brief.ledger_call_id && !failed ? <p className="text-[11px] text-muted-foreground">{t('No ledger call is linked to this brief; provenance cannot be shown.', '该简报未关联账本调用，无法显示来源。')}</p> : null}
            {pick(language, brief.summary_zh, brief.summary_en) ? (
              <p className={cn('text-[13px] leading-6', failed && 'text-muted-foreground')}>{pick(language, brief.summary_zh, brief.summary_en)}</p>
            ) : null}
            {brief.claims.length > 0 ? (
              <ol className="flex flex-col divide-y divide-border rounded-md border border-border">
                {brief.claims.map((claim, index) => (
                  <li key={`${index}-${claim.fact_ids.join(',')}`} className="flex flex-col gap-1 px-3 py-2 text-xs">
                    <div className="flex items-start gap-2">
                      <span className={cn('mono shrink-0 font-semibold', claim.verified ? 'text-policy' : 'text-blocker')} aria-label={claim.verified ? t('Verified', '已核实') : t('Unverified', '未核实')}>
                        {claim.verified ? '✓' : '✗'}
                      </span>
                      <span className={cn('min-w-0 leading-5', !claim.verified && 'line-through decoration-blocker/70 text-muted-foreground')}>{pick(language, claim.text_zh, claim.text_en)}</span>
                    </div>
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 pl-5 text-[11px] text-muted-foreground">
                      {claim.fact_ids.map((factId) => (
                        <Pill key={factId} variant="neutral" className="mono font-normal">
                          {factId}
                        </Pill>
                      ))}
                      {!claim.verified ? <span className="text-blocker">{claim.reason || t('not grounded in any named fact', '未落地到任何具名事实')}</span> : null}
                    </div>
                  </li>
                ))}
              </ol>
            ) : !failed ? (
              <p className="text-xs text-muted-foreground">{t('The brief contains no claims.', '简报不含任何陈述。')}</p>
            ) : null}
            {failed ? (
              <div>
                <Button size="xs" variant="outline" onClick={retry}>
                  {t('Request again', '再次请求')}
                </Button>
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </PanelSection>
  );
}
