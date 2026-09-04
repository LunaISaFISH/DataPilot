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
        <span className="font-semibold text-muted-foreground">{t('Candidate (after actions)', '候选（应用动作后）')}</span>
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
            {row.cand ? <MetricTile metric={row.cand} compareTo={row.base.score} /> : <div className="panel px-3 py-2.5 text-xs text-muted-foreground">{t('Not in candidate profile', '候选画像中不存在')}</div>}
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
          title={t('Not executed yet', '尚未执行')}
          description={
            run.dry_run
              ? t('The change set exists but has not been applied. Validation results, the manifest and downloads appear here after 应用并验证.', '变更集已存在但尚未应用。应用并验证之后，验证结果、清单与下载会出现在这里。')
              : t('Build a change set in 处置, apply it in 变更集, then return here.', '请先在处置页生成变更集，在变更集页应用，然后回到这里。')
          }
          action={
            <Button size="sm" variant="outline" onClick={() => setActiveTab(run.dry_run ? 'changeset' : 'decisions')}>
              {run.dry_run ? t('Go to change set', '前往变更集') : t('Go to decisions', '前往处置')}
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
            {t('Validations', '验证')}
            <ReleaseStatusPill value={manifest.release_status} />
            <span className="mono text-xs font-normal text-muted-foreground">
              {formatInt(summary.passed)} / {formatInt(execution.validations.length)}
            </span>
          </span>
        }
        description={t('Every check the executor ran after writing the candidate. Hashes with the same underline are equal; failing rows show both values in full.', '执行器写出候选文件后运行的全部检查。相同下划线的哈希相等；未通过的行完整显示两侧的值。')}
        flush
      >
        <ValidationTable validations={execution.validations} />
      </PanelSection>

      <PanelSection id="release-metrics" title={t('Baseline vs candidate', '基线 与 候选')} description={t('Same score version and scope on both sides; completeness may not rise by imputation (COMPLETENESS_NOT_IMPUTED).', '两侧使用同一评分版本与范围；完整性不得通过填补上升（COMPLETENESS_NOT_IMPUTED）。')}>
        <MetricComparison baseline={execution.baseline_profile} candidate={execution.candidate_profile} />
      </PanelSection>

      <PanelSection id="release-manifest" title={t('Release manifest', '发布清单')} description={t('release-manifest.json as written to the run directory.', '写入运行目录的 release-manifest.json。')}>
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
        <InlineAlert variant="error" title={t('Release blocked', '发布已阻断')}>
          {t('release.csv is still written so the evidence can be inspected, but the manifest marks it BLOCKED; a failing validation or an unresolved blocking finding is the cause.', 'release.csv 仍会写出以便检查证据，但清单将其标记为已阻断；原因是有验证未通过或存在未处置的阻断性发现。')}
        </InlineAlert>
      ) : null}
    </div>
  );
}
