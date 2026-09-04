'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

import { CopyButton, DataTable, HashChip, InlineAlert, KeyValueList, LifecyclePill, PanelSection, Pill, type DataTableColumn } from '@/components/datapilot';
import { Button } from '@/components/ui/button';
import { ApiError, artifactUrl, getRun } from '@/lib/api';
import { formatBytes, formatDateTime, formatInt } from '@/lib/format';
import { pick, useLanguage } from '@/lib/language';
import { label } from '@/lib/labels';
import type { ArtifactInfo, ArtifactName, ReplayCreated, RunDetail, ValidationResult, VerifyReport } from '@/lib/types';

import { RUNNING_LIFECYCLES, useWorkspace } from '../workspace-context';
import { GuardRow, ObservedValue } from '@/components/datapilot';

const DOWNLOADABLE: ReadonlySet<string> = new Set<ArtifactName>([
  'release.csv',
  'candidate.csv',
  'release-manifest.json',
  'changes.jsonl',
  'ai-ledger.jsonl',
  'audit-bundle.json',
]);

type HashRow = { key: string; zh: string; en: string; left: string | null; right: string | null };

function hashRows(parent: RunDetail | null, child: RunDetail | null): HashRow[] {
  const pick2 = (run: RunDetail | null, get: (run: RunDetail) => string | null | undefined) => (run ? (get(run) ?? null) : null);
  return [
    { key: 'dataset', zh: '数据集', en: 'Dataset', left: pick2(parent, (r) => r.report?.profile.dataset_hash), right: pick2(child, (r) => r.report?.profile.dataset_hash) },
    { key: 'scope', zh: '评分范围', en: 'Scope', left: pick2(parent, (r) => r.report?.profile.scope_hash), right: pick2(child, (r) => r.report?.profile.scope_hash) },
    { key: 'eval', zh: '评估范围', en: 'Evaluation scope', left: pick2(parent, (r) => r.report?.profile.evaluation_scope_hash), right: pick2(child, (r) => r.report?.profile.evaluation_scope_hash) },
    { key: 'contract', zh: '契约', en: 'Contract', left: pick2(parent, (r) => r.contract?.hash), right: pick2(child, (r) => r.contract?.hash) },
    { key: 'actions', zh: '动作集', en: 'Action set', left: pick2(parent, (r) => r.dry_run?.approved_action_set_hash), right: pick2(child, (r) => r.dry_run?.approved_action_set_hash) },
    { key: 'release', zh: '发布文件', en: 'Release', left: pick2(parent, (r) => r.execution?.release_manifest.release_artifact_hash), right: pick2(child, (r) => r.execution?.release_manifest.release_artifact_hash) },
  ];
}

/** Two-run hash equality strip; `一致` only when both sides exist and match. */
function EqualityStrip({ left, right, leftTitle, rightTitle }: { left: RunDetail | null; right: RunDetail | null; leftTitle: string; rightTitle: string }) {
  const { t, language } = useLanguage();
  const rows = hashRows(left, right);
  return (
    <div className="dp-table-wrap">
      <table className="dp-table">
        <thead>
          <tr>
            <th>{t('Hash', '哈希')}</th>
            <th>{leftTitle}</th>
            <th>{rightTitle}</th>
            <th>{t('Result', '结果')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const both = row.left !== null && row.right !== null;
            const equal = both && row.left === row.right;
            return (
              <tr key={row.key}>
                <td>{pick(language, row.zh, row.en)}</td>
                <td>
                  <HashChip value={row.left} length={16} />
                </td>
                <td>
                  <HashChip value={row.right} length={16} />
                </td>
                <td>
                  {!both ? (
                    <Pill variant="neutral">{t('Not yet', '尚无')}</Pill>
                  ) : equal ? (
                    <Pill variant="policy">{t('Equal', '一致')}</Pill>
                  ) : (
                    <Pill variant="blocker">{t('Different', '不一致')}</Pill>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function CommandLine({ command }: { command: string }) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-border bg-muted px-2 py-1">
      <code className="mono min-w-0 flex-1 truncate text-xs" title={command}>
        {command}
      </code>
      <CopyButton value={command} />
    </div>
  );
}

const CHILD_POLL_MS = 2000;

export function ArtifactsTab() {
  const { t, language } = useLanguage();
  const { run, runId, artifacts, busy, refresh, verifyRun, replayRun } = useWorkspace();
  const [verify, setVerify] = useState<VerifyReport | null>(null);
  const [verifyError, setVerifyError] = useState<ApiError | null>(null);
  const [replay, setReplay] = useState<ReplayCreated | null>(null);
  const [replayError, setReplayError] = useState<ApiError | null>(null);
  const [child, setChild] = useState<RunDetail | null>(null);
  const [parent, setParent] = useState<RunDetail | null>(null);
  const [parentError, setParentError] = useState<ApiError | null>(null);
  const [selectedName, setSelectedName] = useState<string | null>(null);

  const childRunning = child === null || RUNNING_LIFECYCLES.has(child.lifecycle);
  const childId = replay?.run_id ?? null;

  // Poll the replayed run every 2 s until it settles (real GET /v1/runs/{child}).
  useEffect(() => {
    if (!childId || !childRunning) return;
    let cancelled = false;
    const controller = new AbortController();
    const load = async () => {
      try {
        const detail = await getRun(childId, controller.signal);
        if (!cancelled) setChild(detail);
      } catch (reason) {
        if (cancelled || (reason instanceof DOMException && reason.name === 'AbortError')) return;
        if (reason instanceof ApiError) setReplayError(reason);
      }
    };
    void load();
    const timer = setInterval(() => void load(), CHILD_POLL_MS);
    return () => {
      cancelled = true;
      controller.abort();
      clearInterval(timer);
    };
  }, [childId, childRunning]);

  if (!run) return null;

  const selected = artifacts.find((artifact) => artifact.name === selectedName) ?? artifacts.find((artifact) => artifact.name === 'release.csv') ?? artifacts[0] ?? null;
  const runDir = `runs/${runId}`;

  const artifactColumns: DataTableColumn<ArtifactInfo>[] = [
    {
      key: 'name',
      header: t('File', '文件'),
      render: (row) => {
        const url = DOWNLOADABLE.has(row.name) ? artifactUrl(runId, row.name as ArtifactName) : null;
        return url ? (
          <a href={url} download={row.name} className="mono underline underline-offset-2" onClick={(event) => event.stopPropagation()}>
            {row.name}
          </a>
        ) : (
          <span className="mono">{row.name}</span>
        );
      },
    },
    { key: 'role', header: t('Role', '用途') },
    { key: 'bytes', header: t('Bytes', '大小'), align: 'right', render: (row) => <span title={`${formatInt(row.bytes)} B`}>{formatBytes(row.bytes)}</span> },
    { key: 'sha256', header: 'sha256', render: (row) => <HashChip value={row.sha256} length={16} /> },
    { key: 'modified_at', header: t('Modified', '修改时间'), render: (row) => <span className="mono text-xs" suppressHydrationWarning>{formatDateTime(row.modified_at, language)}</span> },
  ];

  const checkColumns: DataTableColumn<ValidationResult>[] = [
    {
      key: 'check_id',
      header: t('Check', '检查'),
      render: (row) => (
        <span className="flex flex-col">
          <span>{label('validation', row.check_id, language)}</span>
          <span className="mono text-[11px] text-muted-foreground">{row.check_id}</span>
        </span>
      ),
    },
    {
      key: 'passed',
      header: t('Result', '结果'),
      render: (row) => <Pill variant={row.passed ? 'policy' : 'blocker'}>{row.passed ? t('Pass', '通过') : t('Fail', '未通过')}</Pill>,
    },
    { key: 'observed', header: t('Observed', '观测'), render: (row) => <ObservedValue value={row.observed} /> },
    { key: 'expected', header: t('Expected', '期望'), render: (row) => <ObservedValue value={row.expected} /> },
    { key: 'message', header: t('Message', '说明'), render: (row) => pick(language, row.message_zh, row.message_en) },
  ];

  const runVerify = async () => {
    setVerifyError(null);
    try {
      setVerify(await verifyRun());
    } catch (reason) {
      if (reason instanceof ApiError) setVerifyError(reason);
    }
  };

  const runReplay = async () => {
    setReplayError(null);
    setChild(null);
    try {
      setReplay(await replayRun());
    } catch (reason) {
      if (reason instanceof ApiError) setReplayError(reason);
    }
  };

  const loadParent = async () => {
    if (!run.parent_run_id) return;
    setParentError(null);
    try {
      setParent(await getRun(run.parent_run_id));
    } catch (reason) {
      if (reason instanceof ApiError) setParentError(reason);
    }
  };

  const extraDownloads: ArtifactName[] = (['audit-bundle.json'] as ArtifactName[]).filter((name) => !artifacts.some((artifact) => artifact.name === name) && run.execution !== null);

  return (
    <div className="flex flex-col gap-3">
      <PanelSection
        id="artifacts-list"
        title={t('Run directory', '运行目录')}
        description={
          <span>
            <span className="mono">{runDir}</span> · {t('relative to DATAPILOT_DATA_DIR; every write is atomic and disk is the truth.', '相对 DATAPILOT_DATA_DIR；所有写入均为原子操作，磁盘即真相。')}
          </span>
        }
        actions={
          <Button size="sm" variant="outline" onClick={() => void refresh()} disabled={busy.refresh}>
            {t('Reload list', '刷新列表')}
          </Button>
        }
        flush
      >
        <DataTable
          columns={artifactColumns}
          rows={artifacts}
          rowKey={(row) => row.name}
          selectedKey={selected?.name ?? null}
          onRowClick={(row) => setSelectedName(row.name)}
          maxHeight={360}
          emptyTitle={t('No artifact listing', '没有工件列表')}
          emptyDescription={t('GET /v1/runs/{id}/artifacts returned nothing or failed; see the API log.', 'GET /v1/runs/{id}/artifacts 无结果或失败；请看 API 日志。')}
        />
        {extraDownloads.length > 0 ? (
          <div className="flex flex-wrap items-center gap-2 border-t border-border px-3 py-2 text-xs">
            <span className="text-muted-foreground">{t('Assembled on request', '按需组装')}</span>
            {extraDownloads.map((name) => {
              const url = artifactUrl(runId, name);
              return url ? (
                <a key={name} href={url} download={name} className="mono underline underline-offset-2">
                  {name}
                </a>
              ) : null;
            })}
          </div>
        ) : null}
      </PanelSection>

      <PanelSection
        id="artifacts-commands"
        title={t('Verify outside the browser', '在浏览器之外复验')}
        description={t('Paste into a shell on the API host. The CLI recomputes every hash and re-runs the validations; exit code 0/1.', '在 API 主机的终端中执行。CLI 会重算所有哈希并重跑验证；退出码 0/1。')}
      >
        <div className="flex flex-col gap-2">
          <CommandLine command={`shasum -a 256 ${runDir}/${selected?.name ?? 'release.csv'}`} />
          {selected ? (
            <p className="text-[11px] text-muted-foreground">
              {t('Expected', '期望')} <span className="mono">{selected.sha256}</span>
            </p>
          ) : null}
          <CommandLine command={`python -m datapilot verify ${runDir}`} />
        </div>
      </PanelSection>

      <PanelSection
        id="artifacts-verify"
        title={t('Server-side re-verification', '服务端重新校验')}
        description={t('GET /v1/runs/{id}/verify: recompute source/contract/action-set/decision/candidate/release/change-ledger hashes and re-run execute in memory.', 'GET /v1/runs/{id}/verify：重算源文件/契约/动作集/处置/候选/发布/变更账本哈希，并在内存中重跑执行。')}
        actions={
          <Button size="sm" onClick={() => void runVerify()} disabled={busy.verifyRun}>
            {busy.verifyRun ? t('Verifying', '校验中') : t('Re-verify', '重新校验')}
          </Button>
        }
        flush={verify !== null && !verifyError}
      >
        {verifyError ? <GuardRow error={verifyError} onRetry={() => void runVerify()} /> : null}
        {verify ? (
          <>
            <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-xs">
              <Pill variant={verify.ok ? 'policy' : 'blocker'}>{verify.ok ? t('All checks passed', '全部通过') : t('Verification failed', '校验未通过')}</Pill>
              <span className="mono text-muted-foreground">
                {formatInt(verify.checks.filter((check) => check.passed).length)} / {formatInt(verify.checks.length)}
              </span>
            </div>
            <DataTable columns={checkColumns} rows={verify.checks} rowKey={(row) => row.check_id} maxHeight={360} />
          </>
        ) : !verifyError ? (
          <p className="text-xs text-muted-foreground">{t('Not run yet in this session.', '本次会话尚未运行。')}</p>
        ) : null}
      </PanelSection>

      <PanelSection
        id="artifacts-replay"
        title={t('Replay the same file', '重跑同一文件')}
        description={t('POST /v1/runs/{id}/replay creates a new run from the stored source and contract. Equal hashes on both sides are the determinism proof.', 'POST /v1/runs/{id}/replay 用已存储的源文件与契约创建新运行。两侧哈希一致即为确定性证明。')}
        actions={
          <Button size="sm" variant="outline" onClick={() => void runReplay()} disabled={busy.replayRun || RUNNING_LIFECYCLES.has(run.lifecycle)}>
            {busy.replayRun ? t('Starting', '启动中') : t('Replay', '重跑')}
          </Button>
        }
      >
        <div className="flex flex-col gap-3">
          {replayError ? <GuardRow error={replayError} /> : null}
          {replay ? (
            <div className="flex flex-col gap-2">
              <KeyValueList
                columns={2}
                items={[
                  {
                    key: 'child',
                    label: t('New run', '新运行'),
                    value: (
                      <Link href={`/runs/${encodeURIComponent(replay.run_id)}`} className="mono underline underline-offset-2">
                        {replay.run_id}
                      </Link>
                    ),
                  },
                  { key: 'parent', label: t('Parent', '父运行'), value: <HashChip value={replay.parent_run_id} length={12} /> },
                  { key: 'lifecycle', label: t('Lifecycle', '生命周期'), value: child ? <LifecyclePill value={child.lifecycle} /> : <LifecyclePill value={replay.lifecycle} /> },
                  { key: 'poll', label: t('Polling', '轮询'), value: childRunning ? `GET /v1/runs/${replay.run_id} · 2 s` : t('settled', '已完成'), mono: true },
                ]}
              />
              <EqualityStrip left={run} right={child} leftTitle={t('This run', '本次运行')} rightTitle={t('Replay', '重跑')} />
            </div>
          ) : null}
          {run.parent_run_id ? (
            <div className="flex flex-col gap-2 border-t border-border pt-3">
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                <span>
                  {t('This run is a replay of', '本次运行重跑自')}{' '}
                  <Link href={`/runs/${encodeURIComponent(run.parent_run_id)}`} className="mono underline underline-offset-2">
                    {run.parent_run_id}
                  </Link>
                </span>
                <Button size="xs" variant="outline" onClick={() => void loadParent()}>
                  {t('Compare with parent', '与父运行对比')}
                </Button>
              </div>
              {parentError ? <GuardRow error={parentError} /> : null}
              {parent ? <EqualityStrip left={parent} right={run} leftTitle={t('Parent', '父运行')} rightTitle={t('This run', '本次运行')} /> : null}
            </div>
          ) : null}
          {!replay && !run.parent_run_id ? (
            <InlineAlert variant="info">
              {t('No replay yet. The replayed run gets its own id and event stream; this page keeps polling it until it settles.', '尚未重跑。重跑产生的运行有自己的 ID 与事件流；本页会持续轮询直到其完成。')}
            </InlineAlert>
          ) : null}
        </div>
      </PanelSection>
    </div>
  );
}
