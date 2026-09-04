'use client';

import { useState } from 'react';

import { DataTable, EmptyState, HashChip, InlineAlert, KeyValueList, MetricTile, PanelSection, Pill, ReleaseStatusPill, type DataTableColumn } from '@/components/datapilot';
import { Button } from '@/components/ui/button';
import { formatBytes, formatInt, formatMs, formatScore } from '@/lib/format';
import { sha256Hex } from '@/lib/hash';
import { pick, useLanguage } from '@/lib/language';
import { label } from '@/lib/labels';
import type { ValidationResult } from '@/lib/types';

import type { ReplayBundle, ReplayFile, ReplayManifest } from './replay-data';
import { HashOrUnavailable, IntOrUnavailable, ObservedCell, Unavailable } from './replay-ui';

type LocalCheck =
  | { state: 'idle' }
  | { state: 'running'; started_at: number }
  | { state: 'done'; sha256: string; bytes: number; elapsed_ms: number; matches: 'release' | 'candidate' | null }
  | { state: 'error'; message: string };

function chainRows(manifest: ReplayManifest, t: (en: string, zh: string) => string) {
  return [
    { key: 'source', name: t('Source', '源文件'), field: 'source_artifact_hash', value: manifest.source_artifact_hash },
    { key: 'contract', name: t('Contract', '契约'), field: 'contract_hash', value: manifest.contract_hash },
    { key: 'policy', name: t('Policy pack', '策略包'), field: 'policy_pack_hash', value: manifest.policy_pack_hash },
    { key: 'scope', name: t('Scope', '评分范围'), field: 'scope_hash', value: manifest.scope_hash },
    { key: 'decisions', name: t('Decisions', '处置集'), field: 'decision_set_hash', value: manifest.decision_set_hash },
    { key: 'candidate', name: t('Candidate', '候选文件'), field: 'candidate_artifact_hash', value: manifest.candidate_artifact_hash },
    { key: 'release', name: t('Release', '发布文件'), field: 'release_artifact_hash', value: manifest.release_artifact_hash },
    { key: 'ledger', name: t('Change ledger', '变更账本'), field: 'change_ledger_hash', value: manifest.change_ledger_hash },
  ];
}

export function ReplayReleaseTab({ bundle }: { bundle: ReplayBundle }) {
  const { t, language } = useLanguage();
  const [check, setCheck] = useState<LocalCheck>({ state: 'idle' });
  const execution = bundle.execution;
  const manifest = bundle.manifest ?? execution?.release_manifest ?? null;
  const csv = bundle.files.find((file) => file.name === 'cleaned.csv') ?? null;

  if (!execution && !manifest) {
    return <EmptyState title={t('Execution record unavailable', '执行记录不可用')} description={t('release-report.json and release-manifest.json are both missing.', 'release-report.json 与 release-manifest.json 均缺失。')} />;
  }

  const validations = execution?.validations ?? [];
  const failed = validations.filter((row) => !row.passed).length;
  const validationColumns: DataTableColumn<ValidationResult>[] = [
    {
      key: 'check_id',
      header: t('Check', '检查项'),
      render: (row) => (
        <span className="inline-flex flex-col">
          <span className="mono text-xs">{row.check_id}</span>
          <span className="text-[11px] text-muted-foreground">{label('validation', row.check_id, language)}</span>
        </span>
      ),
    },
    { key: 'passed', header: t('Result', '结果'), render: (row) => <Pill variant={row.passed ? 'policy' : 'blocker'}>{row.passed ? t('Pass', '通过') : t('Fail', '未通过')}</Pill> },
    { key: 'observed', header: t('Observed', '观测值'), render: (row) => <ObservedCell value={row.observed} /> },
    { key: 'expected', header: t('Expected', '期望值'), render: (row) => <ObservedCell value={row.expected} /> },
    { key: 'message', header: t('Explanation', '说明'), render: (row) => <span className="text-xs">{pick(language, row.message_zh, row.message_en) || '—'}</span> },
  ];

  const baseline = execution?.baseline_profile ?? bundle.report?.profile ?? null;
  const candidate = execution?.candidate_profile ?? null;
  const baselineByName = new Map((baseline?.metrics ?? []).map((metric) => [metric.name, metric.score]));

  const fileColumns: DataTableColumn<ReplayFile>[] = [
    { key: 'name', header: t('File', '文件'), render: (row) => <span className="mono text-xs">{row.name}</span> },
    { key: 'role', header: t('Role', '用途'), render: (row) => <span className="text-xs">{pick(language, row.role_zh, row.role_en)}</span> },
    { key: 'bytes', header: t('Size', '大小'), align: 'right', render: (row) => (row.bytes === null ? <Unavailable /> : formatBytes(row.bytes)) },
    {
      key: 'status',
      header: t('Status', '状态'),
      render: (row) => (
        <Pill variant={row.status === 'ok' ? 'policy' : 'blocker'} className="mono">
          {row.http_status ?? '—'} · {row.status}
        </Pill>
      ),
    },
    {
      key: 'download',
      header: t('Download', '下载'),
      render: (row) =>
        row.status === 'ok' ? (
          <a href={row.path} download={row.name} className="text-xs text-policy underline underline-offset-2">
            {row.name}
          </a>
        ) : (
          '—'
        ),
    },
  ];

  const runLocalCheck = async () => {
    const started = performance.now();
    setCheck({ state: 'running', started_at: started });
    try {
      const response = await fetch('/demo/cleaned.csv');
      if (!response.ok) {
        setCheck({ state: 'error', message: `GET /demo/cleaned.csv → ${response.status}` });
        return;
      }
      const bytes = await response.arrayBuffer();
      const digest = await sha256Hex(bytes);
      const matches = digest === manifest?.release_artifact_hash ? 'release' : digest === manifest?.candidate_artifact_hash ? 'candidate' : null;
      setCheck({ state: 'done', sha256: digest, bytes: bytes.byteLength, elapsed_ms: performance.now() - started, matches });
    } catch (reason) {
      setCheck({ state: 'error', message: reason instanceof Error ? reason.message : String(reason) });
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <PanelSection
        id="replay-validations"
        title={t('Validations at apply', '执行时的验证')}
        description={t('Every gate the recorded execution passed through; observed and expected side by side.', '已记录执行经过的每道门禁；观测值与期望值并列。')}
        actions={
          <span className="mono text-[11px] text-muted-foreground">
            {formatInt(validations.length - failed)} / {formatInt(validations.length)} {t('passed', '通过')}
          </span>
        }
        flush
      >
        <DataTable columns={validationColumns} rows={validations} rowKey={(row) => row.check_id} className="rounded-none border-0" ariaLabel={t('Validations', '验证')} emptyTitle={t('No validations recorded', '未记录验证')} />
      </PanelSection>

      <PanelSection
        id="replay-metrics-compare"
        title={t('Baseline vs candidate', '基线 vs 候选')}
        description={t('Same scope, same score version; the delta on each tile is candidate minus baseline.', '相同范围、相同评分版本；每块指标的差值为候选减基线。')}
        actions={
          <span className="mono text-[11px] text-muted-foreground">
            {formatScore(baseline?.overall_score)} → {formatScore(candidate?.overall_score)}
          </span>
        }
      >
        {candidate && candidate.metrics.length > 0 ? (
          <div className="grid grid-cols-2 gap-2 xl:grid-cols-4">
            {candidate.metrics.map((metric) => (
              <MetricTile key={metric.name} metric={metric} compareTo={baselineByName.get(metric.name) ?? null} />
            ))}
          </div>
        ) : (
          <Unavailable reason={t('no candidate profile in this artifact', '工件未包含候选画像')} />
        )}
      </PanelSection>

      <div className="grid gap-3 xl:grid-cols-2">
        <PanelSection
          id="replay-manifest"
          title={t('Release manifest', '发布清单')}
          actions={manifest ? <ReleaseStatusPill value={manifest.release_status} /> : null}
        >
          {manifest ? (
            <div className="flex flex-col gap-3">
              <div className="dp-table-wrap">
                <table className="dp-table">
                  <thead>
                    <tr>
                      <th>{t('Link', '环节')}</th>
                      <th>{t('Field', '字段')}</th>
                      <th>sha256</th>
                    </tr>
                  </thead>
                  <tbody>
                    {chainRows(manifest, t).map((row, index, rows) => (
                      <tr key={row.key}>
                        <td>
                          <span className="inline-flex items-center gap-1.5">
                            <span className="mono text-[11px] text-muted-foreground">{index + 1}/{rows.length}</span>
                            {row.name}
                          </span>
                        </td>
                        <td>
                          <span className="mono text-[11px] text-muted-foreground">{row.field}</span>
                        </td>
                        <td>
                          <HashOrUnavailable value={row.value} length={24} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <KeyValueList
                columns={2}
                items={[
                  { key: 'engine', label: t('Engine', '引擎'), value: manifest.engine_version ?? <Unavailable />, mono: true },
                  { key: 'score_version', label: t('Score version', '评分版本'), value: manifest.score_version ?? <Unavailable />, mono: true },
                  { key: 'total', label: t('Total source records', '源记录总数'), value: <IntOrUnavailable value={manifest.total_source_records} /> },
                  { key: 'eligible', label: t('Eligible', '可发布'), value: <IntOrUnavailable value={manifest.eligible_record_count} /> },
                  { key: 'quarantined', label: t('Quarantined', '隔离'), value: <IntOrUnavailable value={manifest.quarantined_record_count} /> },
                  { key: 'excluded', label: t('Excluded', '排除'), value: <IntOrUnavailable value={manifest.excluded_record_count} /> },
                  { key: 'flagged', label: t('Flagged', '标记待审'), value: <IntOrUnavailable value={manifest.flagged_record_count} /> },
                  {
                    key: 'excluded_columns',
                    label: t('Excluded columns', '排除字段'),
                    value: manifest.excluded_columns.length === 0 ? t('None', '无') : <span className="mono text-xs">{manifest.excluded_columns.join(', ')}</span>,
                  },
                  {
                    key: 'validation_summary',
                    label: t('Validation summary', '验证汇总'),
                    value: manifest.validation_summary ? (
                      <span className="mono text-xs">
                        {formatInt(manifest.validation_summary.passed)} {t('passed', '通过')} · {formatInt(manifest.validation_summary.failed)} {t('failed', '未通过')}
                      </span>
                    ) : (
                      <Unavailable />
                    ),
                  },
                  {
                    key: 'ai',
                    label: t('Model calls', '模型调用'),
                    value:
                      manifest.ai_call_count === null ? (
                        <Unavailable reason={t('not in this artifact', '工件未包含')} />
                      ) : (
                        <span className="text-xs">
                          {formatInt(manifest.ai_call_count)}
                          {manifest.ai_provider ? <span> · {label('provider', manifest.ai_provider, language)}</span> : null}
                        </span>
                      ),
                  },
                ]}
              />
              {Object.keys(manifest.finding_outcome_counts).length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {Object.entries(manifest.finding_outcome_counts).map(([outcome, count]) => (
                    <Pill key={outcome} variant="neutral" title={outcome}>
                      {label('disposition', outcome, language)} <span className="mono font-normal">{formatInt(count)}</span>
                    </Pill>
                  ))}
                </div>
              ) : null}
            </div>
          ) : (
            <Unavailable reason={t('release-manifest.json missing', 'release-manifest.json 缺失')} />
          )}
        </PanelSection>

        <div className="flex flex-col gap-3">
          <PanelSection
            id="replay-downloads"
            title={t('Replay files', '回放文件')}
            description={t('The static artifacts this page is built from. Sizes are the bytes the browser received.', '本页所依据的静态工件；大小为浏览器实际收到的字节数。')}
            flush
          >
            <DataTable columns={fileColumns} rows={bundle.files} rowKey={(row) => row.name} className="rounded-none border-0" ariaLabel={t('Replay files', '回放文件')} />
          </PanelSection>

          <PanelSection
            id="replay-local-check"
            title={t('Local re-verification', '本地复验')}
            description={t('Fetch cleaned.csv, hash the raw bytes with WebCrypto SHA-256 in this browser and compare with the manifest.', '下载 cleaned.csv，在本浏览器中用 WebCrypto SHA-256 对原始字节求哈希，并与清单比对。')}
            actions={
              <Button size="sm" variant="outline" onClick={() => void runLocalCheck()} disabled={check.state === 'running' || !csv || csv.status !== 'ok'}>
                {check.state === 'running' ? t('Hashing', '计算中') : t('Verify cleaned.csv', '复验 cleaned.csv')}
              </Button>
            }
          >
            {check.state === 'idle' ? (
              <p className="text-xs text-muted-foreground">
                {t('Manifest release hash', '清单中的发布文件哈希')}: <HashOrUnavailable value={manifest?.release_artifact_hash ?? null} length={16} />
              </p>
            ) : null}
            {check.state === 'running' ? (
              <InlineAlert variant="info">
                <span className="mono">GET /demo/cleaned.csv</span> · {t('request in flight', '请求进行中')}
              </InlineAlert>
            ) : null}
            {check.state === 'error' ? (
              <InlineAlert variant="error" title={t('Local check failed', '本地复验失败')}>
                <span className="mono">{check.message}</span>
              </InlineAlert>
            ) : null}
            {check.state === 'done' ? (
              <div className="flex flex-col gap-2">
                <InlineAlert variant={check.matches ? 'info' : 'warning'} title={check.matches ? t('Hash matches the manifest', '哈希与清单一致') : t('Hash does not match the manifest', '哈希与清单不一致')}>
                  <span className="text-xs">
                    {formatBytes(check.bytes)} · {formatMs(check.elapsed_ms)}
                    {check.matches ? <span> · {check.matches === 'release' ? 'release_artifact_hash' : 'candidate_artifact_hash'}</span> : null}
                  </span>
                </InlineAlert>
                <KeyValueList
                  items={[
                    { key: 'computed', label: t('Computed in browser', '浏览器计算'), value: <HashChip value={check.sha256} length={64} /> },
                    { key: 'release', label: 'release_artifact_hash', value: <HashOrUnavailable value={manifest?.release_artifact_hash ?? null} length={64} /> },
                    { key: 'candidate', label: 'candidate_artifact_hash', value: <HashOrUnavailable value={manifest?.candidate_artifact_hash ?? null} length={64} /> },
                  ]}
                />
              </div>
            ) : null}
          </PanelSection>
        </div>
      </div>
    </div>
  );
}
