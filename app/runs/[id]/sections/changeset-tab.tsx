'use client';

import { useState } from 'react';

import { EmptyState, InlineAlert, PanelSection, Pill, ReleaseStatusPill } from '@/components/datapilot';
import { Button } from '@/components/ui/button';
import { ApiError, newIdempotencyKey } from '@/lib/api';
import { useApiLog } from '@/lib/api-log';
import { formatDateTime, formatInt } from '@/lib/format';
import { useLanguage } from '@/lib/language';
import type { DryRunReport, RunDetail } from '@/lib/types';

import { useWorkspace, type ApplyOutcome } from '../workspace-context';
import { GuardRow } from '@/components/datapilot';
import { ActionTable } from './release/action-table';
import { ChangePreviewTable } from './release/change-preview';
import { EqHash, FullHash } from './release/hash-equality';
import { Reconciliation, countsFromDryRun } from './release/reconciliation';
import { validationSummary } from './release/validation-table';

type Staleness = { stale: boolean; reason: string | null };

/** A change set is stale when the run moved past it: revision bumped (contract replaced) or decisions changed. */
function staleness(run: RunDetail, dryRun: DryRunReport, t: (en: string, zh: string) => string): Staleness {
  if (dryRun.run_revision !== run.run_revision) {
    return {
      stale: true,
      reason: t(
        `Built at revision ${dryRun.run_revision}; the run is now at revision ${run.run_revision} (contract replaced, decisions cleared).`,
        `构建于修订 ${dryRun.run_revision}；运行现为修订 ${run.run_revision}（契约已更换，处置已清空）。`,
      ),
    };
  }
  const decisionIds = Object.keys(run.decisions);
  const newer = decisionIds.filter((id) => !(id in dryRun.finding_dispositions));
  if (newer.length > 0) {
    return { stale: true, reason: t(`Decisions changed after the dry run: ${newer.join(', ')}.`, `预演之后处置发生变化：${newer.join('、')}。`) };
  }
  if (run.lifecycle === 'REVIEW_REQUIRED' && !run.execution) {
    return { stale: true, reason: t('The server moved the run back to review; regenerate the change set from 处置.', '服务端已将运行退回待审查；请在处置页重新生成变更集。') };
  }
  return { stale: false, reason: null };
}

export function ChangesetTab() {
  const { t, language } = useLanguage();
  const { run, runId, busy, applyRun, setActiveTab, setSelectedFindingId } = useWorkspace();
  const apiLog = useApiLog();
  const [idempotencyKey, setIdempotencyKey] = useState<string>(() => newIdempotencyKey());
  const [outcome, setOutcome] = useState<ApplyOutcome | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  if (!run) return null;
  const dryRun = run.dry_run;

  if (!dryRun) {
    return (
      <EmptyState
        title={t('No change set yet', '尚无变更集')}
        description={t('Finish the decisions first: every non-policy finding needs an outcome, then 生成变更集 builds the typed action set.', '请先完成处置：每个非策略授权的发现都需要一个结果，然后用「生成变更集」构建类型化动作集。')}
        action={
          <Button size="sm" variant="outline" onClick={() => setActiveTab('decisions')}>
            {t('Go to decisions', '前往处置')}
          </Button>
        }
      />
    );
  }

  const recordCount = run.report?.profile.record_count ?? null;
  const stale = staleness(run, dryRun, t);
  const applied = run.execution !== null;
  const blocked = dryRun.blocking_unresolved.length > 0;
  const canApply = !applied && !stale.stale && !blocked && !busy.applyRun;

  // A replayed apply is visible either from the last outcome's meta or, after a remount, from the API log.
  const loggedReplay = apiLog.some((entry) => entry.method === 'POST' && entry.path === `/v1/runs/${runId}/apply` && entry.idempotentReplay);
  const replayed = outcome?.meta.idempotentReplay === true || loggedReplay;

  const submit = async () => {
    setError(null);
    try {
      const result = await applyRun({ run_revision: run.run_revision, approved_action_set_hash: dryRun.approved_action_set_hash, idempotency_key: idempotencyKey });
      setOutcome(result);
    } catch (reason) {
      if (reason instanceof ApiError) setError(reason);
    }
  };

  const resetKey = () => {
    setIdempotencyKey(newIdempotencyKey());
    setOutcome(null);
    setError(null);
  };

  const applyBody = { run_revision: run.run_revision, approved_action_set_hash: dryRun.approved_action_set_hash, idempotency_key: idempotencyKey };
  const executionSummary = run.execution ? validationSummary(run.execution.validations) : null;

  return (
    <div className="flex flex-col gap-3">
      {stale.stale ? (
        <InlineAlert variant="warning" title={<span className="inline-flex items-center gap-2"><Pill variant="review">{t('Stale', '已失效')}</Pill>{t('This change set no longer matches the run state', '此变更集已与运行状态不一致')}</span>}
          actions={
            <Button size="sm" variant="outline" onClick={() => setActiveTab('decisions')}>
              {t('Regenerate in decisions', '前往处置重新生成')}
            </Button>
          }
        >
          {stale.reason}
        </InlineAlert>
      ) : null}

      <PanelSection
        id="changeset-actions"
        title={t('Approved action set', '已批准动作集')}
        description={
          <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>
              {t('Revision', '修订')} <span className="mono">{dryRun.run_revision}</span>
            </span>
            <span>
              {t('Actions', '动作')} <span className="mono">{formatInt(dryRun.actions.length)}</span>
            </span>
            <span>
              {t('Affected records / cells', '受影响记录 / 单元格')} <span className="mono">{formatInt(dryRun.affected_record_count)} / {formatInt(dryRun.affected_cell_count)}</span>
            </span>
            {dryRun.excluded_columns.length > 0 ? (
              <span>
                {t('Excluded columns', '排除字段')} <span className="mono">{dryRun.excluded_columns.join(', ')}</span>
              </span>
            ) : null}
          </span>
        }
        actions={
          <span className="inline-flex flex-wrap items-center gap-2">
            <EqHash label={t('action set', '动作集')} value={dryRun.approved_action_set_hash} length={12} />
            <EqHash label={t('decisions', '处置')} value={dryRun.decision_set_hash} length={12} />
          </span>
        }
        flush
      >
        <ActionTable actions={dryRun.actions} onSelectFinding={setSelectedFindingId} />
        <div className="border-t border-border px-3 py-2">
          <Reconciliation counts={countsFromDryRun(dryRun, recordCount)} />
        </div>
        {blocked ? (
          <div className="border-t border-border px-3 py-2">
            <InlineAlert variant="error" title={t('Blocking findings unresolved', '阻断性发现未处置')}>
              <span className="mono">{dryRun.blocking_unresolved.join(' · ')}</span> · {t('The release stays BLOCKED until each has an outcome.', '在每个发现都有处置结果之前，发布保持阻断。')}
            </InlineAlert>
          </div>
        ) : null}
      </PanelSection>

      <PanelSection
        id="changeset-preview"
        title={t('Change preview', '变更预览')}
        description={t('Cell-level rewrites the executor will make. Row-level actions only move records between release, quarantine and exclusion.', '执行器将进行的单元格级改写。行级动作只在发布、隔离与排除之间移动记录。')}
        flush
      >
        {run.preview ? (
          <ChangePreviewTable preview={run.preview} onSelectFinding={setSelectedFindingId} />
        ) : (
          <p className="px-3 py-3 text-xs text-muted-foreground">{t('The server returned no preview for this dry run.', '服务端未返回本次预演的预览。')}</p>
        )}
      </PanelSection>

      <PanelSection
        id="changeset-apply"
        title={t('Apply and validate', '应用并验证')}
        description={t('POST /v1/runs/{id}/apply executes exactly this action set, then runs every validation. The request body below is what is sent; the server refuses with 409 if any hash moved.', 'POST /v1/runs/{id}/apply 精确执行此动作集，然后运行全部验证。下方即为发送的请求体；任一哈希变化时服务端以 409 拒绝。')}
      >
        <div className="flex flex-col gap-3">
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-xs">
            <dt className="text-muted-foreground">{t('Source artifact', '源文件')}</dt>
            <dd>
              <FullHash value={dryRun.source_artifact_hash} />
            </dd>
            <dt className="text-muted-foreground">approved_action_set_hash</dt>
            <dd>
              <FullHash value={dryRun.approved_action_set_hash} />
            </dd>
            <dt className="text-muted-foreground">decision_set_hash</dt>
            <dd>
              <FullHash value={dryRun.decision_set_hash} />
            </dd>
            <dt className="text-muted-foreground">run_revision</dt>
            <dd className="mono">{run.run_revision}</dd>
            <dt className="text-muted-foreground">{t('Counts', '计数')}</dt>
            <dd className="mono">
              {t('releasable', '可发布')} {formatInt(dryRun.eligible_record_count)} · {t('quarantined', '隔离')} {formatInt(dryRun.quarantined_record_count)} · {t('excluded', '排除')} {formatInt(dryRun.excluded_record_count)} · {t('flagged', '标记')} {formatInt(dryRun.flagged_record_count)}
            </dd>
            <dt className="text-muted-foreground">idempotency_key</dt>
            <dd className="flex flex-wrap items-center gap-2">
              <span className="mono break-all">{idempotencyKey}</span>
              {!applied ? (
                <Button size="xs" variant="ghost" onClick={resetKey} disabled={busy.applyRun}>
                  {t('New key', '重新生成')}
                </Button>
              ) : null}
            </dd>
          </dl>
          <details className="text-xs">
            <summary className="cursor-pointer text-muted-foreground">{t('Request body (JSON)', '请求体（JSON）')}</summary>
            <pre className="mono mt-1 overflow-x-auto rounded-md border border-border bg-muted p-2 text-[11px] leading-4">{JSON.stringify(applyBody, null, 2)}</pre>
          </details>

          {error ? <GuardRow error={error} onRetry={error.code === 'STALE_DRY_RUN' || error.code === 'ACTION_SET_CHANGED' || error.code === 'SOURCE_ARTIFACT_CHANGED' ? undefined : () => void submit()} actions={
            error.code === 'STALE_DRY_RUN' || error.code === 'ACTION_SET_CHANGED' ? (
              <Button size="sm" variant="outline" onClick={() => setActiveTab('decisions')}>
                {t('Regenerate change set', '重新生成变更集')}
              </Button>
            ) : error.code === 'VALIDATION_FAILED' ? (
              <Button size="sm" variant="outline" onClick={() => setActiveTab('release')}>
                {t('See validations', '查看验证')}
              </Button>
            ) : undefined
          } /> : null}

          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={() => void submit()} disabled={!canApply}>
              {busy.applyRun ? t('Applying', '应用中') : applied ? t('Applied', '已应用') : t('Apply and validate', '应用并验证')}
            </Button>
            {busy.applyRun ? (
              <span className="mono text-xs text-muted-foreground">POST /v1/runs/{runId}/apply · Idempotency-Key {idempotencyKey.slice(0, 8)}…</span>
            ) : null}
            {applied && run.execution ? (
              <span className="inline-flex flex-wrap items-center gap-2 text-xs">
                <ReleaseStatusPill value={run.execution.release_manifest.release_status} />
                <span className="mono text-muted-foreground">
                  {t('validations', '验证')} {formatInt(executionSummary?.passed ?? 0)} / {formatInt(run.execution.validations.length)}
                </span>
                {replayed ? <Pill variant="info" title="X-Idempotent-Replay: true">{t('Idempotent replay', '幂等重放')} · X-Idempotent-Replay</Pill> : null}
                <Button size="sm" variant="outline" onClick={() => setActiveTab('release')}>
                  {t('Open validation and release', '打开验证与发布')}
                </Button>
              </span>
            ) : null}
            {!applied && stale.stale ? <span className="text-xs text-muted-foreground">{t('Disabled: change set is stale.', '已禁用：变更集已失效。')}</span> : null}
            {!applied && !stale.stale && blocked ? <span className="text-xs text-muted-foreground">{t('Disabled: blocking findings are unresolved.', '已禁用：阻断性发现未处置。')}</span> : null}
          </div>

          {outcome ? (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-border px-3 py-2 text-xs">
              <span className="text-muted-foreground">{t('Last response', '最近响应')}</span>
              <span className="mono">HTTP {outcome.meta.status}</span>
              {outcome.meta.serverMs !== null ? <span className="mono">Server-Timing {outcome.meta.serverMs} ms</span> : null}
              <span className="mono">{t('client', '客户端')} {outcome.meta.clientMs} ms</span>
              {outcome.meta.correlationId ? <span className="mono text-muted-foreground">{outcome.meta.correlationId}</span> : null}
              {outcome.meta.idempotentReplay ? <Pill variant="info">X-Idempotent-Replay: true</Pill> : <span className="text-muted-foreground">{t('executed now', '本次执行')}</span>}
              <span className="text-muted-foreground" suppressHydrationWarning>
                {formatDateTime(new Date().toISOString(), language)}
              </span>
            </div>
          ) : null}
        </div>
      </PanelSection>
    </div>
  );
}
