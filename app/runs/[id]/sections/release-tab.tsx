'use client';

import { useCallback } from 'react';

import { EmptyState, InlineAlert, MetricTile, PanelSection, ReleaseStatusPill } from '@/components/datapilot';
import { Button } from '@/components/ui/button';
import { formatInt, formatScore } from '@/lib/format';
import { useLanguage } from '@/lib/language';
import { label } from '@/lib/labels';
import type { MetricScore, ProfileSummary } from '@/lib/types';

import { useWorkspace } from '../workspace-context';
import { BriefPanel } from './release/brief-panel';
import { Downloads } from './release/downloads';
import { EqHash } from './release/hash-equality';
import { LocalVerify } from './release/local-verify';
import { ManifestCard } from './release/manifest-card';
import { Reconciliation, countsFromManifest } from './release/reconciliation';
import { TamperTestPanel } from './release/tamper-test-panel';
import { ValidationTable, validationSummary } from './release/validation-table';

/** Baseline and candidate metric tiles side by side, one row per metric name. */
function MetricComparison({ baseline, candidate }: { baseline: ProfileSummary; candidate: ProfileSummary }) {
  const { t, language } = useLanguage();
  const candidateByName = new Map(candidate.metrics.map((metric) => [metric.name, metric]));
  const rows: { name: string; base: MetricScore; cand: MetricScore | null }[] = baseline.metrics.map((metric) => ({ name: metric.name, base: metric, cand: candidateByName.get(metric.name) ?? null }));
  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-[auto_minmax(0,1fr)_minmax(0,1fr)] items-center gap-x-3 gap-y-1 text-xs">
        <span />
        <span className="font-semibold text-muted-foreground">{t('Baseline (source)', '基线（源文件）')}</span>
        <span className="font-semibold text-muted-foreground">{t('Candidate (after actions)', '处理后')}</span>
        <span className="text-muted-foreground">{t('Records', '记录')}</span>
        <span className="mono">{formatInt(baseline.record_count)}</span>
        <span className="mono">
          {formatInt(candidate.record_count)}
          {candidate.record_count !== baseline.record_count ? <span className="ml-1 text-muted-foreground">({candidate.record_count - baseline.record_count > 0 ? '+' : ''}{formatInt(candidate.record_count - baseline.record_count)})</span> : null}
        </span>
        <span className="text-muted-foreground">{t('Columns', '字段')}</span>
        <span className="mono">{formatInt(baseline.column_count)}</span>
        <span className="mono">{formatInt(candidate.column_count)}</span>
        <span className="text-muted-foreground">{label('metric', 'overall', language)}</span>
        <span className="mono font-semibold">{formatScore(baseline.overall_score)}</span>
        <span className="mono font-semibold">{formatScore(candidate.overall_score)}</span>
        <span className="text-muted-foreground">{t('Scope hash', '评分范围')}</span>
        <EqHash value={baseline.scope_hash} length={12} />
        <EqHash value={candidate.scope_hash} length={12} />
        <span className="text-muted-foreground">{t('Evaluation scope', '评估范围')}</span>
        <EqHash value={baseline.evaluation_scope_hash} length={12} />
        <EqHash value={candidate.evaluation_scope_hash} length={12} />
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {rows.map((row) => (
          <div key={row.name} className="grid grid-cols-2 gap-2">
            <MetricTile metric={row.base} />
            {row.cand ? <MetricTile metric={row.cand} compareTo={row.base.score} /> : <div className="panel px-3 py-2.5 text-xs text-muted-foreground">{t('Not in candidate profile', '处理后的数据中没有这一项')}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}

export function ReleaseTab() {
  const { t } = useLanguage();
  const { run, runId, artifacts, ledger, refresh, setActiveTab } = useWorkspace();
  const onBriefSettled = useCallback(() => {
    void refresh();
  }, [refresh]);

  if (!run) return null;
  const execution = run.execution;

  if (!execution) {
    return (
      <div className="flex flex-col gap-3">
        <EmptyState
          title={t('Not executed yet', '还没有交付结果')}
          description={
            run.dry_run
              ? t('The change set exists but has not been applied. Results appear here after apply and validation.', '执行预览已经生成。完成处理和交付检查后，结果与下载文件会出现在这里。')
              : t('Choose how to handle issues, preview the execution, then return here.', '请先确认问题的处理方式并预览执行结果，再回到这里查看交付结果。')
          }
          action={
            <Button size="sm" variant="outline" onClick={() => setActiveTab(run.dry_run ? 'changeset' : 'decisions')}>
              {run.dry_run ? t('Go to change set', '去执行处理') : t('Go to decisions', '去处理问题')}
            </Button>
          }
        />
        <TamperTestPanel />
      </div>
    );
  }

  const manifest = execution.release_manifest;
  const summary = validationSummary(execution.validations);

  return (
    <div className="flex flex-col gap-3">
      <PanelSection
        id="release-validations"
        title={
          <span className="inline-flex flex-wrap items-center gap-2">
            {t('Validations', '交付检查')}
            <ReleaseStatusPill value={manifest.release_status} />
            <span className="mono text-xs font-normal text-muted-foreground">
              {formatInt(summary.passed)} / {formatInt(execution.validations.length)}
            </span>
          </span>
        }
        description={t('Every check run after writing the candidate. Failing rows show both values in full.', '处理完成后运行的全部检查；未通过的项目会显示实际值与预期值。')}
        flush
      >
        <ValidationTable validations={execution.validations} />
      </PanelSection>

      <PanelSection id="release-metrics" title={t('Baseline vs candidate', '处理前后质量对比')} description={t('Both sides use the same score version and scope.', '处理前后使用同一评分版本和记录范围，隔离或排除不会虚增质量分。')}>
        <MetricComparison baseline={execution.baseline_profile} candidate={execution.candidate_profile} />
      </PanelSection>

      <PanelSection id="release-manifest" title={t('Release manifest', '交付清单')} description={t('The final scope, counts and traceable hashes.', '记录最终交付范围、数量和可复核哈希。')}>
        <div className="flex flex-col gap-3">
          <Reconciliation counts={countsFromManifest(manifest)} />
          <ManifestCard manifest={manifest} dryRun={execution.dry_run} />
        </div>
      </PanelSection>

      <div className="grid gap-3 xl:grid-cols-2">
        <PanelSection id="release-downloads" title={t('Downloads', '下载')} description={t('Served from the run directory by GET /v1/runs/{id}/artifacts/<name>.', '由 GET /v1/runs/{id}/artifacts/<name> 从运行目录提供。')}>
          <Downloads runId={runId} artifacts={artifacts} />
        </PanelSection>
        <PanelSection id="release-local-verify" title={t('Local re-verification', '本地复验')}>
          <LocalVerify runId={runId} manifest={manifest} />
        </PanelSection>
      </div>

      <TamperTestPanel />

      <BriefPanel runId={runId} initial={run.brief} ledger={ledger} onSettled={onBriefSettled} />

      {manifest.release_status === 'BLOCKED' ? (
        <InlineAlert variant="error" title={t('Release blocked', '当前结果不可交付')}>
          {t('The manifest is blocked because a validation failed or an issue that affects release remains unresolved.', '有交付检查未通过，或仍有影响交付的问题没有处理。系统保留了检查文件，但不会把它标记为可交付结果。')}
        </InlineAlert>
      ) : null}
    </div>
  );
}
