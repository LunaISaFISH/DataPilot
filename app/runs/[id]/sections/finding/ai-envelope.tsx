'use client';

import type { ReactNode } from 'react';

import { HashChip, Pill } from '@/components/datapilot';
import { formatBytes, formatInt, formatMs, formatTime } from '@/lib/format';
import { useLanguage } from '@/lib/language';
import { label } from '@/lib/labels';
import type { AICallRecord, Finding } from '@/lib/types';
import { cn } from '@/lib/utils';

import { GroundingGates, modelRecordCount } from './grounding-gates';
import { JsonBlock } from './helpers';

function Pane({ index, title, meta, children, tone = 'neutral' }: { index: string; title: string; meta?: ReactNode; children: ReactNode; tone?: 'neutral' | 'ai' | 'policy' | 'blocker' }) {
  return (
    <section className="flex flex-col gap-2 rounded-md border border-border p-2.5">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <span className="inline-flex items-center gap-2">
          <span className={cn('mono inline-flex size-5 items-center justify-center rounded-sm border text-[11px]', tone === 'ai' && 'border-ai/40 text-ai', tone === 'policy' && 'border-policy/40 text-policy', tone === 'blocker' && 'border-blocker/40 text-blocker', tone === 'neutral' && 'border-border text-muted-foreground')}>
            {index}
          </span>
          <span className="text-[13px] font-semibold">{title}</span>
        </span>
        {meta ? <span className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">{meta}</span> : null}
      </header>
      {children}
    </section>
  );
}

function statusVariant(status: AICallRecord['status']): 'policy' | 'neutral' | 'blocker' | 'ai' {
  if (status === 'ok') return 'policy';
  if (status === 'cached') return 'ai';
  if (status === 'abstained') return 'neutral';
  return 'blocker';
}

/**
 * AI 评估 envelope: 发送 (the exact redacted request from the ledger) / 返回 (the structured
 * response and its cost) / 接地校验 (every gate, engine recount vs model claim). Rendered only
 * when a ledger record exists for the finding; otherwise the caller shows the deterministic card.
 */
export function AiEnvelope({ finding, record }: { finding: Finding; record: AICallRecord }) {
  const { t, language } = useLanguage();
  const proposal = finding.proposal;
  const request = record.request_payload;
  const response = record.response_payload;
  const redaction = record.redaction;
  const grounding = record.grounding ?? proposal?.grounding ?? null;
  const cached = record.status === 'cached';
  const modelCount = modelRecordCount(response);
  const inputHashMatches = proposal ? proposal.input_hash === record.input_hash : null;

  return (
    <div className="flex flex-col gap-2">
      <Pane
        index="1"
        title={t('Sent', '发送')}
        tone="ai"
        meta={
          <>
            <span className="mono">{label('ai_task', record.task, language)}</span>
            <span>·</span>
            <span className="mono">{record.model_requested}</span>
            <span>·</span>
            <span className="mono">{record.prompt_version}</span>
          </>
        }
      >
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          <span>
            {t('Raw records', '原始记录')} <span className="mono">{formatInt(redaction.rows_sent)}</span> {t('rows', '行')}
          </span>
          <span>·</span>
          <span>
            {t('Masked columns', '已遮蔽字段')} <span className="mono">{formatInt(redaction.columns_withheld.length)}</span>
          </span>
          <span>·</span>
          <span>
            {t('Values sent', '发送值')} <span className="mono">{formatInt(redaction.values_sent)}</span>
          </span>
          <span>·</span>
          <span>
            {t('Chars', '字符')} <span className="mono">{formatInt(redaction.chars_sent)}</span>
          </span>
        </div>
        {redaction.columns_withheld.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
            <span>{t('Withheld', '未发送字段')}</span>
            {redaction.columns_withheld.map((column) => (
              <Pill key={column} variant="neutral" className="mono font-normal">
                {column}
              </Pill>
            ))}
          </div>
        ) : null}
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <HashChip value={record.input_hash} label="input_hash" />
          <span className="text-muted-foreground">
            <span className="mono">{formatInt(record.request_bytes)}</span> {t('UTF-8 bytes', 'UTF-8 字节')}
            <span className="mono"> ({formatBytes(record.request_bytes)})</span>
          </span>
          {inputHashMatches === false ? <Pill variant="blocker">{t('proposal input_hash differs', '提议 input_hash 不一致')}</Pill> : null}
        </div>
        <details className="rounded-md border border-border" open>
          <summary className="cursor-pointer px-2 py-1 text-xs hover:bg-muted">
            request_payload · {t('verbatim', '原样')}
          </summary>
          <div className="border-t border-border p-1">
            {request ? <JsonBlock value={request} className="border-0" /> : <p className="px-1 py-1 text-xs text-muted-foreground">{t('The ledger record carries no request payload.', '账本记录未包含请求载荷。')}</p>}
          </div>
        </details>
      </Pane>

      <Pane
        index="2"
        title={t('Returned', '返回')}
        tone={statusVariant(record.status) === 'blocker' ? 'blocker' : 'ai'}
        meta={
          <>
            <Pill variant={statusVariant(record.status)}>{label('ai_status', record.status, language)}</Pill>
            {record.request_id ? <span className="mono">{record.request_id}</span> : null}
          </>
        }
      >
        {cached ? (
          <p className="rounded-md border border-ai/30 bg-ai-tint px-2 py-1 text-xs text-ai">
            {t('Served from the response cache: the live call failed and an identical input_hash was found. Not a fresh model answer.', '由响应缓存提供：实时调用失败后命中相同 input_hash。并非本次新的模型回答。')}
          </p>
        ) : null}
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-xs">
          <dt className="text-muted-foreground">{t('Model served', '实际模型')}</dt>
          <dd className="mono">{record.model_served ?? <span className="text-muted-foreground">{t('none (no model answered)', '无（模型未应答）')}</span>}</dd>
          <dt className="text-muted-foreground">{t('Prompt version', '提示词版本')}</dt>
          <dd className="mono">{record.prompt_version}</dd>
          <dt className="text-muted-foreground">{t('Latency', '延迟')}</dt>
          <dd className="mono">{formatMs(record.latency_ms)}</dd>
          <dt className="text-muted-foreground">{t('Tokens in / out / cache read', 'Token 输入 / 输出 / 缓存读取')}</dt>
          <dd className="mono">
            {formatInt(record.input_tokens)} / {formatInt(record.output_tokens)} / {formatInt(record.cache_read_tokens)}
          </dd>
          <dt className="text-muted-foreground">{t('Output hash', '输出哈希')}</dt>
          <dd>{record.output_hash ? <HashChip value={record.output_hash} /> : <span className="mono text-muted-foreground">—</span>}</dd>
          <dt className="text-muted-foreground">{t('Recorded at', '记录时间')}</dt>
          <dd className="mono" suppressHydrationWarning>
            {formatTime(record.created_at)}
          </dd>
        </dl>
        <details className="rounded-md border border-border" open>
          <summary className="cursor-pointer px-2 py-1 text-xs hover:bg-muted">response_payload</summary>
          <div className="border-t border-border p-1">
            {response ? <JsonBlock value={response} className="border-0" /> : <p className="px-1 py-1 text-xs text-muted-foreground">{t('No structured response was recorded (timeout, error or refusal).', '未记录结构化响应（超时、错误或拒答）。')}</p>}
          </div>
        </details>
      </Pane>

      <Pane index="3" title={t('Grounding', '接地校验')} tone={grounding ? (grounding.valid ? 'policy' : 'blocker') : 'neutral'}>
        <GroundingGates grounding={grounding} request={request} proposal={response} modelCount={modelCount} />
      </Pane>
    </div>
  );
}
