'use client';

import { useEffect, useState } from 'react';

import { DataTable, HashChip, KeyValueList, PanelSection, Pill, ProvenanceMark, provenanceFromRecord, type DataTableColumn } from '@/components/datapilot';
import { Button } from '@/components/ui/button';
import { ApiError, getAiContract } from '@/lib/api';
import { formatInt, formatMs, formatTime } from '@/lib/format';
import { sha256Hex } from '@/lib/hash';
import { pick, useLanguage } from '@/lib/language';
import { label, labelKeys } from '@/lib/labels';
import type { AICallRecord, AiContract } from '@/lib/types';
import { cn } from '@/lib/utils';

import { useWorkspace } from '../workspace-context';
import { GuardRow } from '@/components/datapilot';

const DEFAULT_MAX_CALLS = 8;
const TASKS = ['semantic', 'contract_draft', 'brief'] as const;

// The permission card describes the backend, not the run: fetch it once per page load.
let contractCache: Promise<AiContract> | null = null;
function loadAiContract(): Promise<AiContract> {
  if (!contractCache) {
    contractCache = getAiContract().catch((reason: unknown) => {
      contractCache = null;
      throw reason;
    });
  }
  return contractCache;
}

function List({ title, items, tone }: { title: string; items: string[]; tone: 'policy' | 'blocker' | 'ai' | 'neutral' }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className={cn('text-[11px] font-semibold', tone === 'policy' && 'text-policy', tone === 'blocker' && 'text-blocker', tone === 'ai' && 'text-ai', tone === 'neutral' && 'text-muted-foreground')}>
        {title}
      </div>
      <ul className="flex flex-col gap-0.5 text-xs">
        {items.length === 0 ? <li className="text-muted-foreground">—</li> : items.map((item) => <li key={item} className="break-words">{item}</li>)}
      </ul>
    </div>
  );
}

function JsonDetails({ summary, value }: { summary: string; value: unknown }) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return (
    <details className="group rounded-md border border-border">
      <summary className="cursor-pointer px-2 py-1 text-xs hover:bg-muted">{summary}</summary>
      <pre className="mono max-h-64 overflow-auto border-t border-border bg-muted px-2 py-1.5 text-[11px] leading-4 whitespace-pre-wrap break-all">{text}</pre>
    </details>
  );
}

function PermissionCard({ contract }: { contract: AiContract }) {
  const { t, language } = useLanguage();
  const [vector, setVector] = useState<{ computed: string; equal: boolean } | null>(null);
  const [vectorError, setVectorError] = useState<string | null>(null);
  const proposable = contract.allowed_proposals.map((action) => (action === null ? t('No proposal (abstain)', '不提议（弃权）') : label('allowed_action', action, language)));
  const notProposable = labelKeys('allowed_action')
    .filter((action) => !contract.allowed_proposals.includes(action as (typeof contract.allowed_proposals)[number]))
    .map((action) => label('allowed_action', action, language));

  const checkVector = async () => {
    setVectorError(null);
    try {
      const bytes = new TextEncoder().encode(contract.canonical_test_vector.json);
      const computed = await sha256Hex(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
      setVector({ computed, equal: computed === contract.canonical_test_vector.sha256.toLowerCase() });
    } catch (reason) {
      setVectorError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  return (
    <PanelSection
      id="ai-permission"
      title={t('AI permission card', 'AI 权限卡')}
      description={t('Read from the running backend (GET /v1/ai/contract), never hand-written.', '来自运行中的后端（GET /v1/ai/contract），非手写。')}
      bodyClassName="flex flex-col gap-3 p-3"
    >
      <div className="grid grid-cols-2 gap-3">
        <List title={t('Visible to the model', '可见')} items={contract.visible_to_model} tone="policy" />
        <List title={t('Never visible', '不可见')} items={contract.never_visible} tone="blocker" />
        <List title={t('May propose', '可提议')} items={proposable} tone="ai" />
        <List title={t('May not propose', '不可')} items={notProposable} tone="neutral" />
      </div>

      <div className="dp-table-wrap">
        <table className="dp-table">
          <thead>
            <tr>
              <th>{t('Task', '任务')}</th>
              <th>{t('Prompt', '提示词版本')}</th>
              <th>{t('Effort', '推理强度')}</th>
              <th data-align="right">max_tokens</th>
              <th data-align="right">{t('Timeout', '超时')}</th>
            </tr>
          </thead>
          <tbody>
            {TASKS.map((task) => (
              <tr key={task}>
                <td>{label('ai_task', task, language)}</td>
                <td className="mono text-xs">{contract.prompt_versions[task] ?? '—'}</td>
                <td className="mono text-xs">{contract.effort[task] ?? '—'}</td>
                <td className="cell-num">{contract.max_tokens[task] !== undefined ? formatInt(contract.max_tokens[task]) : '—'}</td>
                <td className="cell-num">{contract.timeout_seconds[task] !== undefined ? `${contract.timeout_seconds[task]} s` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <KeyValueList
        items={[
          { key: 'provider', label: t('Provider', '提供方'), value: label('provider', contract.provider, language) },
          { key: 'model', label: t('Model', '模型'), value: contract.model, mono: true },
          { key: 'max', label: t('Max calls per run', '每次运行调用上限'), value: formatInt(contract.max_calls_per_run), mono: true },
        ]}
      />

      <div className="flex flex-col gap-1.5">
        {TASKS.map((task) => (
          <JsonDetails key={`schema-${task}`} summary={`${t('Output schema', '输出结构')} · ${label('ai_task', task, language)}`} value={contract.output_schemas[task] ?? null} />
        ))}
        {TASKS.map((task) => (
          <JsonDetails key={`prompt-${task}`} summary={`${t('System prompt', '系统提示词')} · ${label('ai_task', task, language)}`} value={contract.system_prompts[task] ?? '—'} />
        ))}
        <details className="rounded-md border border-border">
          <summary className="cursor-pointer px-2 py-1 text-xs hover:bg-muted">
            {t('Grounding reason codes', '落地校验原因码')} · {formatInt(contract.grounding_reason_codes.length)}
          </summary>
          <ul className="flex flex-col divide-y divide-border border-t border-border text-xs">
            {contract.grounding_reason_codes.map((reason) => (
              <li key={reason.code} className="flex items-baseline justify-between gap-2 px-2 py-1">
                <span className="mono">{reason.code}</span>
                <span className="text-right text-muted-foreground">{pick(language, reason.zh, reason.en) || label('grounding_reason', reason.code, language)}</span>
              </li>
            ))}
          </ul>
        </details>
      </div>

      <div className="flex flex-col gap-1 border-t border-border pt-2">
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
          <span>{t('Canonical test vector', '规范化测试向量')}</span>
          <Button size="xs" variant="outline" onClick={() => void checkVector()}>
            {t('Verify in browser', '浏览器校验')}
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <HashChip value={contract.canonical_test_vector.sha256} label={t('server', '服务端')} length={16} />
          {vector ? (
            <>
              <HashChip value={vector.computed} label={t('browser', '浏览器')} length={16} />
              <Pill variant={vector.equal ? 'policy' : 'blocker'}>{vector.equal ? t('Equal', '一致') : t('Different', '不一致')}</Pill>
            </>
          ) : null}
        </div>
        {vectorError ? <p className="text-[11px] text-blocker">{vectorError}</p> : null}
      </div>
    </PanelSection>
  );
}

export function AiSupervisionRail() {
  const { t, language } = useLanguage();
  const { ledger, health, setSelectedFindingId } = useWorkspace();
  const [contract, setContract] = useState<AiContract | null>(null);
  const [contractError, setContractError] = useState<ApiError | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    loadAiContract()
      .then((value) => {
        if (!cancelled) {
          setContract(value);
          setContractError(null);
        }
      })
      .catch((reason: unknown) => {
        if (!cancelled && reason instanceof ApiError) setContractError(reason);
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const info = health.health?.ai ?? null;
  const maxCalls = contract?.max_calls_per_run ?? DEFAULT_MAX_CALLS;
  const budgetCalls = ledger.filter((record) => record.provider === 'anthropic' && record.task !== 'redteam').length;

  const columns: DataTableColumn<AICallRecord>[] = [
    {
      key: 'task',
      header: t('Task', '任务'),
      render: (row) => (
        <span className="flex flex-col">
          <span>{label('ai_task', row.task, language)}</span>
          {row.finding_id ? <span className="mono text-[11px] text-muted-foreground">{row.finding_id}</span> : null}
        </span>
      ),
    },
    {
      key: 'model',
      header: t('Model', '模型'),
      render: (row) => (
        <span className="inline-flex items-center gap-1">
          <ProvenanceMark provenance={provenanceFromRecord(row)} />
          <span className="mono text-xs">{row.model_served ?? row.model_requested}</span>
        </span>
      ),
    },
    {
      key: 'status',
      header: t('Status', '状态'),
      render: (row) => (
        <Pill variant={row.status === 'ok' || row.status === 'cached' ? 'policy' : row.status === 'abstained' ? 'neutral' : 'blocker'}>
          {label('ai_status', row.status, language)}
        </Pill>
      ),
    },
    { key: 'tokens', header: t('Tokens in / out', 'Token 入 / 出'), align: 'right', render: (row) => `${formatInt(row.input_tokens)} / ${formatInt(row.output_tokens)}` },
    { key: 'latency', header: t('Latency', '延迟'), align: 'right', render: (row) => formatMs(row.latency_ms) },
    {
      key: 'grounding',
      header: t('Grounding', '落地校验'),
      render: (row) =>
        row.grounding ? (
          <span className={cn('text-xs', row.grounding.valid ? 'text-policy' : 'text-blocker')} title={row.grounding.reason_codes.join(', ')}>
            {row.grounding.valid ? t('Passed', '通过') : `${t('Rejected', '拦截')} · ${row.grounding.reason_codes.length}`}
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    { key: 'time', header: t('Time', '时间'), render: (row) => <span className="mono text-xs" suppressHydrationWarning>{formatTime(row.created_at)}</span> },
  ];

  return (
    <div className="flex flex-col gap-3 p-3">
      <PanelSection
        id="ai-provider"
        title={t('AI supervision', 'AI 监管')}
        description={t('Provider, budget and the flight recorder for this run.', '本次运行的提供方、预算与飞行记录仪。')}
      >
        <KeyValueList
          items={[
            {
              key: 'provider',
              label: t('Provider / mode', '提供方 / 模式'),
              value: info ? (
                <span className="inline-flex items-center gap-1.5">
                  <Pill variant={info.available && info.provider === 'anthropic' ? 'ai' : 'neutral'}>{label('provider', info.provider, language)}</Pill>
                  <span className="mono text-xs">{info.mode}</span>
                </span>
              ) : (
                <span className="text-muted-foreground">{health.error ? health.error.code : '—'}</span>
              ),
            },
            { key: 'model', label: t('Model', '模型'), value: info?.model ?? '—', mono: true },
            {
              key: 'budget',
              label: t('Calls used', '已用调用'),
              value: (
                <span className={cn('mono', budgetCalls >= maxCalls && 'text-blocker')}>
                  {formatInt(budgetCalls)} / {formatInt(maxCalls)}
                </span>
              ),
            },
            { key: 'ledger', label: t('Ledger records', '账本记录'), value: formatInt(ledger.length), mono: true },
          ]}
        />
      </PanelSection>

      {contractError ? (
        <GuardRow error={contractError} title={t('Permission card unavailable', '权限卡不可用')} onRetry={() => setAttempt((n) => n + 1)} />
      ) : contract ? (
        <PermissionCard contract={contract} />
      ) : (
        <p className="text-xs text-muted-foreground mono">GET /v1/ai/contract …</p>
      )}

      <PanelSection id="ai-ledger" title={t('AI ledger', 'AI 账本')} description={t('One row per call; click a row to open its finding.', '每次调用一行；点击行打开对应问题。')} flush>
        <DataTable
          columns={columns}
          rows={ledger}
          rowKey={(row) => row.call_id}
          onRowClick={(row) => {
            if (row.finding_id) setSelectedFindingId(row.finding_id);
          }}
          maxHeight={360}
          emptyTitle={t('No AI calls recorded', '尚无 AI 调用记录')}
          emptyDescription={t('Semantic, draft and brief calls appear here as they are made.', '语义、起草与简报调用发生后会出现在这里。')}
        />
      </PanelSection>
    </div>
  );
}
