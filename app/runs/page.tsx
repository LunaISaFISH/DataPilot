'use client';

import { RefreshCw } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

import {
  ConfirmDialog,
  DataTable,
  GuardRow,
  InlineAlert,
  LifecyclePill,
  PanelSection,
  ReleaseStatusPill,
  type DataTableColumn,
} from '@/components/datapilot';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { ApiError, deleteRun, listRuns, replayRun, useLiveApiAvailable } from '@/lib/api';
import { formatDateTime, formatInt } from '@/lib/format';
import { useLanguage } from '@/lib/language';
import { label, labelKeys } from '@/lib/labels';
import type { RunSummary } from '@/lib/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toApiError(reason: unknown): ApiError {
  if (reason instanceof ApiError) return reason;
  const detail = reason instanceof Error ? reason.message : String(reason);
  return new ApiError({
    code: 'CLIENT_ERROR',
    message_zh: `浏览器端错误：${detail}`,
    message_en: `Client-side error: ${detail}`,
    retryable: false,
    status: 0,
  });
}

function isAbort(reason: unknown): boolean {
  return reason instanceof DOMException && reason.name === 'AbortError';
}

type RowAction = { runId: string; kind: 'replay' | 'delete' } | null;

const ALL = '__all__';

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function RunsPage() {
  const { t, language } = useLanguage();
  const router = useRouter();
  const available = useLiveApiAvailable();

  const [tick, setTick] = useState(0);
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [loading, setLoading] = useState(available);
  const [loadError, setLoadError] = useState<ApiError | null>(null);

  const [lifecycle, setLifecycle] = useState<string>(ALL);
  const [query, setQuery] = useState('');

  const [action, setAction] = useState<RowAction>(null);
  const [actionError, setActionError] = useState<{ context: string; error: ApiError } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<RunSummary | null>(null);

  useEffect(() => {
    if (!available) return;
    const controller = new AbortController();
    let cancelled = false;
    const run = async () => {
      setLoading(true);
      try {
        const data = await listRuns(controller.signal);
        if (cancelled) return;
        setRuns([...data].sort((a, b) => b.created_at.localeCompare(a.created_at)));
        setLoadError(null);
      } catch (reason) {
        if (cancelled || isAbort(reason)) return;
        setLoadError(toApiError(reason));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void run();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [available, tick]);

  const refresh = () => setTick((n) => n + 1);

  const replay = async (row: RunSummary) => {
    if (action) return;
    setAction({ runId: row.run_id, kind: 'replay' });
    setActionError(null);
    try {
      const created = await replayRun(row.run_id);
      router.push(`/runs/${encodeURIComponent(created.run_id)}`);
    } catch (reason) {
      setActionError({ context: t('Could not rerun this analysis', '无法重新运行这次分析'), error: toApiError(reason) });
      setAction(null);
    }
  };

  const remove = async () => {
    if (!deleteTarget) return;
    const target = deleteTarget;
    setAction({ runId: target.run_id, kind: 'delete' });
    setActionError(null);
    try {
      await deleteRun(target.run_id);
      setDeleteTarget(null);
      refresh();
    } catch (reason) {
      setActionError({ context: t('Could not delete this analysis', '无法删除这次分析'), error: toApiError(reason) });
      setDeleteTarget(null);
    } finally {
      setAction(null);
    }
  };

  const needle = query.trim().toLowerCase();
  const filtered = (runs ?? []).filter((row) => {
    if (lifecycle !== ALL && row.lifecycle !== lifecycle) return false;
    if (!needle) return true;
    return (
      row.run_id.toLowerCase().includes(needle) ||
      row.source_name.toLowerCase().includes(needle) ||
      (row.sample_id ?? '').toLowerCase().includes(needle)
    );
  });

  const columns: DataTableColumn<RunSummary>[] = [
    {
      key: 'run_id',
      header: t('Run', '运行'),
      render: (row) => (
        <Link
          href={`/runs/${encodeURIComponent(row.run_id)}`}
          className="mono text-xs text-foreground underline-offset-2 hover:underline"
        >
          {row.run_id}
        </Link>
      ),
    },
    {
      key: 'source_name',
      header: t('Source', '来源文件'),
      render: (row) => (
        <span className="inline-block max-w-64 truncate align-bottom" title={row.source_name}>
          {row.source_name}
        </span>
      ),
    },
    {
      key: 'sample_id',
      header: t('Sample', '样例'),
      render: (row) => (row.sample_id ? <span className="mono text-xs">{row.sample_id}</span> : <span className="text-muted-foreground">—</span>),
    },
    { key: 'record_count', header: t('Records', '记录'), align: 'right', render: (row) => formatInt(row.record_count) },
    { key: 'column_count', header: t('Columns', '字段'), align: 'right', render: (row) => formatInt(row.column_count) },
    { key: 'run_revision', header: t('Rev', '修订'), align: 'right', render: (row) => formatInt(row.run_revision) },
    { key: 'contract_source', header: t('Contract', '契约'), render: (row) => label('contract_source', row.contract_source, language) },
    { key: 'lifecycle', header: t('Lifecycle', '状态'), render: (row) => <LifecyclePill value={row.lifecycle} /> },
    { key: 'release_status', header: t('Release', '发布状态'), render: (row) => <ReleaseStatusPill value={row.release_status} /> },
    {
      key: 'created_at',
      header: t('Created', '创建时间'),
      render: (row) => (
        <span className="mono text-xs whitespace-nowrap" suppressHydrationWarning>
          {formatDateTime(row.created_at, language)}
        </span>
      ),
    },
    {
      key: 'actions',
      header: t('Actions', '操作'),
      align: 'right',
      render: (row) => {
        const busy = action?.runId === row.run_id ? action.kind : null;
        return (
          <span className="inline-flex items-center gap-1">
            <Button size="xs" variant="ghost" nativeButton={false} render={<Link href={`/runs/${encodeURIComponent(row.run_id)}`} />}>
              {t('Open', '打开')}
            </Button>
            <Button size="xs" variant="outline" disabled={action !== null} onClick={() => void replay(row)}>
              {busy === 'replay' ? t('Replaying', '重跑中') : t('Rerun same file', '重跑同一文件')}
            </Button>
            <Button size="xs" variant="destructive" disabled={action !== null} onClick={() => setDeleteTarget(row)}>
              {busy === 'delete' ? t('Deleting', '删除中') : t('Delete', '删除')}
            </Button>
          </span>
        );
      },
    },
  ];

  return (
    <div className="min-h-[calc(100dvh-var(--shell-header-height)-var(--shell-status-height))] bg-[linear-gradient(180deg,#f7f8f5_0%,#eef3f1_72%)]">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 pt-7 pb-16 sm:px-8 sm:pt-10 lg:px-10">
      <header className="flex flex-col gap-2">
        <div className="text-xs font-medium text-policy">{t('Saved analyses', '历史分析')}</div>
        <h1 className="text-2xl font-semibold tracking-[-0.04em] text-ink sm:text-3xl">{t('Pick up where you left off', '继续之前的数据分析')}</h1>
        <p className="max-w-2xl text-[13px] leading-6 text-muted-foreground sm:text-sm">
          {t(
            'Open a previous result, or rerun the same file to compare a fresh assessment with the earlier one.',
            '打开以前的结果，或用同一份文件重新分析，对比前后的变化。',
          )}
        </p>
      </header>

      {!available ? (
        <InlineAlert variant="info" title={t('Analysis history is temporarily unavailable', '历史分析暂时不可用')}>
          {t('Your saved analyses will appear again when the service reconnects.', '服务恢复连接后，你保存的分析会重新显示。')}
        </InlineAlert>
      ) : null}

      <PanelSection
        id="run-history"
        title={t('Runs', '运行')}
        description={
          runs
            ? t(`${filtered.length} of ${runs.length} shown`, `显示 ${filtered.length} / ${runs.length} 条`)
            : t('Loading your recent work…', '正在加载最近的分析…')
        }
        className="border-black/8 shadow-[0_18px_60px_rgba(16,35,30,0.05)]"
        flush
        actions={
          <>
            <Input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('Filter by run id, file or sample', '按运行 ID、文件或样例筛选')}
              aria-label={t('Filter runs', '筛选运行')}
              className="h-7 w-56 text-xs md:text-xs"
              disabled={!available}
            />
            <NativeSelect
              size="sm"
              value={lifecycle}
              onChange={(event) => setLifecycle(event.target.value)}
              aria-label={t('Lifecycle filter', '状态筛选')}
              disabled={!available}
              className="text-xs"
            >
              <NativeSelectOption value={ALL}>{t('All lifecycles', '全部状态')}</NativeSelectOption>
              {labelKeys('lifecycle').map((key) => (
                <NativeSelectOption key={key} value={key}>
                  {label('lifecycle', key, language)}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            <Button size="xs" variant="ghost" disabled={!available || loading} onClick={refresh}>
              <RefreshCw data-icon="inline-start" aria-hidden="true" />
              {t('Refresh', '刷新')}
            </Button>
          </>
        }
      >
        {loading && !runs ? (
          <div className="px-4 py-4 text-xs text-muted-foreground" aria-live="polite">
            {t('Loading analyses…', '正在加载分析…')}
          </div>
        ) : null}
        {loadError ? <GuardRow error={loadError} title={t('Could not load analysis history', '无法加载历史分析')} className="m-3" /> : null}
        {actionError ? <GuardRow error={actionError.error} title={actionError.context} className="m-3" /> : null}
        <DataTable
          columns={columns}
          rows={filtered}
          rowKey={(row) => row.run_id}
          ariaLabel={t('Run history', '运行记录')}
          className="rounded-none border-0"
          emptyTitle={
            !available
              ? t('Live API not connected', '未连接实时 API')
              : runs && runs.length > 0
                ? t('No runs match the filter', '没有符合筛选条件的运行')
                : t('No runs yet', '暂无运行记录')
          }
          emptyDescription={
            available && (!runs || runs.length === 0) ? (
              <Link href="/workbench" className="text-policy underline-offset-2 hover:underline">
                {t('Create one from the workbench', '前往工作台创建')}
              </Link>
            ) : undefined
          }
        />
      </PanelSection>

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title={t('Delete this run', '删除此运行')}
        description={t(
          'Removes the run directory including source, report, decisions, manifests and ledger. This cannot be undone.',
          '删除该运行目录，包括源文件、报告、处置、清单与账本。此操作不可撤销。',
        )}
        confirmLabel={t('Delete', '删除')}
        destructive
        pending={action?.kind === 'delete'}
        onConfirm={remove}
      >
        {deleteTarget ? (
          <dl className="data-dense flex flex-col gap-1">
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">{t('Run', '运行')}</dt>
              <dd className="mono text-xs">{deleteTarget.run_id}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">{t('Source', '来源文件')}</dt>
              <dd className="truncate">{deleteTarget.source_name}</dd>
            </div>
          </dl>
        ) : null}
      </ConfirmDialog>
      </div>
    </div>
  );
}
