'use client';

import { FileText, RefreshCw, Upload } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useRef, useState } from 'react';

import {
  ConfirmDialog,
  DataTable,
  GuardRow,
  InlineAlert,
  LifecyclePill,
  PanelSection,
  Pill,
  ReleaseStatusPill,
  type DataTableColumn,
} from '@/components/datapilot';
import { Button } from '@/components/ui/button';
import {
  ApiError,
  cleanupRuns,
  createRun,
  createRunFromSample,
  listRuns,
  listSamples,
  useLiveApiAvailable,
} from '@/lib/api';
import { formatBytes, formatDateTime, formatInt } from '@/lib/format';
import { pick, useLanguage } from '@/lib/language';
import { label } from '@/lib/labels';
import type { RunSummary, SampleInfo } from '@/lib/types';
import { cn } from '@/lib/utils';

// ---------------------------------------------------------------------------
// Small shared helpers (local to this page)
// ---------------------------------------------------------------------------

const RECENT_LIMIT = 8;

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

/** The request currently in flight, shown instead of a spinner. */
function InFlight({ method, path }: { method: string; path: string }) {
  return (
    <div className="mono px-3 py-2 text-[11px] text-muted-foreground" aria-live="polite">
      {method} {path} …
    </div>
  );
}

type ListState<T> = { data: T | null; error: ApiError | null; loading: boolean };

function useApiList<T>(load: (signal?: AbortSignal) => Promise<T>, enabled: boolean, tick: number): ListState<T> {
  const [state, setState] = useState<ListState<T>>({ data: null, error: null, loading: enabled });

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let cancelled = false;
    const run = async () => {
      setState((prev) => (prev.loading ? prev : { ...prev, loading: true }));
      try {
        const data = await load(controller.signal);
        if (!cancelled) setState({ data, error: null, loading: false });
      } catch (reason) {
        if (cancelled || isAbort(reason)) return;
        setState((prev) => ({ data: prev.data, error: toApiError(reason), loading: false }));
      }
    };
    void run();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [enabled, load, tick]);

  return state;
}

// ---------------------------------------------------------------------------
// Encoding hint (display only; the server decides how to decode)
// ---------------------------------------------------------------------------

type EncodingHint = 'reading' | 'utf-8-sig' | 'utf-8' | 'ascii' | 'gb18030-likely' | 'unknown';

const SNIFF_BYTES = 4096;

function readHead(file: File): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'));
    reader.onload = () => {
      const result = reader.result;
      resolve(result instanceof ArrayBuffer ? new Uint8Array(result) : new Uint8Array(0));
    };
    reader.readAsArrayBuffer(file.slice(0, SNIFF_BYTES));
  });
}

function decodes(bytes: Uint8Array, encoding: string): boolean {
  try {
    new TextDecoder(encoding, { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/** Sniff the first 4 KiB: BOM, pure ASCII, strict UTF-8, else GB18030 as a hint. */
async function sniffEncoding(file: File): Promise<EncodingHint> {
  const bytes = await readHead(file);
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return 'utf-8-sig';
  if (bytes.every((b) => b < 0x80)) return 'ascii';
  // A multibyte sequence may be cut at the 4 KiB boundary: tolerate up to 3 trailing bytes.
  for (let trim = 0; trim <= 3 && trim < bytes.length; trim += 1) {
    if (decodes(bytes.subarray(0, bytes.length - trim), 'utf-8')) return 'utf-8';
  }
  for (let trim = 0; trim <= 3 && trim < bytes.length; trim += 1) {
    if (decodes(bytes.subarray(0, bytes.length - trim), 'gb18030')) return 'gb18030-likely';
  }
  return 'unknown';
}

function encodingText(hint: EncodingHint, t: (en: string, zh: string) => string): { text: string; tone: 'neutral' | 'review' | 'blocker' } {
  switch (hint) {
    case 'reading':
      return { text: t('Reading the first 4 KiB', '正在读取前 4 KiB'), tone: 'neutral' };
    case 'utf-8-sig':
      return { text: t('UTF-8 with BOM', 'UTF-8（带 BOM）'), tone: 'neutral' };
    case 'utf-8':
      return { text: 'UTF-8', tone: 'neutral' };
    case 'ascii':
      return { text: t('ASCII (UTF-8 compatible)', 'ASCII（UTF-8 兼容）'), tone: 'neutral' };
    case 'gb18030-likely':
      return {
        text: t('Not valid UTF-8; likely GB18030, transcoded server-side', '按 UTF-8 解码失败，疑似 GB18030；服务端解析时转码'),
        tone: 'review',
      };
    case 'unknown':
      return {
        text: t('Unrecognised encoding; the engine accepts UTF-8 or GB18030 only', '无法识别的编码；引擎仅接受 UTF-8 或 GB18030'),
        tone: 'blocker',
      };
  }
}

// ---------------------------------------------------------------------------
// Drop zone
// ---------------------------------------------------------------------------

type DropZoneProps = {
  file: File | null;
  onFile: (file: File | null) => void;
  accept: string;
  extensions: string[];
  title: string;
  hint: string;
  disabled?: boolean;
  compact?: boolean;
  children?: React.ReactNode;
};

function hasAllowedExtension(name: string, extensions: string[]): boolean {
  const lower = name.toLowerCase();
  return extensions.some((ext) => lower.endsWith(ext));
}

function DropZone({ file, onFile, accept, extensions, title, hint, disabled = false, compact = false, children }: DropZoneProps) {
  const { t } = useLanguage();
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const [rejected, setRejected] = useState<string | null>(null);

  const take = (list: FileList | null) => {
    const candidate = list && list.length > 0 ? list[0] : null;
    if (!candidate) return;
    if (!hasAllowedExtension(candidate.name, extensions)) {
      setRejected(candidate.name);
      return;
    }
    setRejected(null);
    onFile(candidate);
  };

  const open = () => {
    if (!disabled) inputRef.current?.click();
  };

  return (
    <div className="flex flex-col gap-1.5">
      <input
        ref={inputRef}
        id={inputId}
        type="file"
        accept={accept}
        className="sr-only"
        tabIndex={-1}
        disabled={disabled}
        aria-hidden="true"
        onChange={(event) => {
          take(event.target.files);
          event.target.value = '';
        }}
      />
      <button
        type="button"
        disabled={disabled}
        aria-label={title}
        onClick={open}
        onDragOver={(event) => {
          if (disabled) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'copy';
          if (!dragging) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          if (disabled) return;
          take(event.dataTransfer.files);
        }}
        className={cn(
          'flex w-full cursor-pointer flex-col items-start justify-center gap-1 rounded-md border border-dashed px-3 text-left transition-colors',
          compact ? 'min-h-14 py-2' : 'min-h-28 py-4',
          dragging ? 'border-policy bg-policy-tint' : 'border-border bg-background hover:bg-muted/60',
          'disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-background',
        )}
      >
        <span className="flex items-center gap-2 text-[13px] font-medium">
          {compact ? <FileText aria-hidden="true" className="size-4 text-muted-foreground" /> : <Upload aria-hidden="true" className="size-4 text-muted-foreground" />}
          <span>{title}</span>
        </span>
        {file ? (
          <span className="data-dense flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
            <span className="mono text-xs break-all">{file.name}</span>
            <span className="mono text-xs text-muted-foreground">{formatBytes(file.size)}</span>
            {children}
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">{hint}</span>
        )}
      </button>
      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
        {file ? (
          <button
            type="button"
            className="underline-offset-2 hover:underline"
            onClick={() => {
              onFile(null);
              setRejected(null);
            }}
          >
            {t('Clear', '清除')}
          </button>
        ) : null}
        {rejected ? (
          <span className="text-blocker">
            {t('Not accepted:', '不接受此文件：')} <span className="mono">{rejected}</span> · {extensions.join(' ')}
          </span>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// New release assessment (upload)
// ---------------------------------------------------------------------------

function NewAssessmentCard({ available }: { available: boolean }) {
  const { t } = useLanguage();
  const router = useRouter();
  const [csv, setCsv] = useState<File | null>(null);
  const [contract, setContract] = useState<File | null>(null);
  const [encoding, setEncoding] = useState<EncodingHint>('reading');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    if (!csv) return;
    let cancelled = false;
    sniffEncoding(csv).then(
      (hint) => {
        if (!cancelled) setEncoding(hint);
      },
      () => {
        if (!cancelled) setEncoding('unknown');
      },
    );
    return () => {
      cancelled = true;
    };
  }, [csv]);

  const submit = async () => {
    if (!csv || pending) return;
    setPending(true);
    setError(null);
    try {
      const created = await createRun(csv, contract);
      router.push(`/runs/${encodeURIComponent(created.run_id)}`);
    } catch (reason) {
      setError(toApiError(reason));
      setPending(false);
    }
  };

  const enc = encodingText(encoding, t);

  return (
    <PanelSection
      id="new-assessment"
      title={t('New release assessment', '新建发布评估')}
      description={t(
        'One CSV (UTF-8 or GB18030, ≤ 25 MiB) and an optional Data Contract YAML. Without a contract the run is observational only.',
        '一个 CSV（UTF-8 或 GB18030，≤ 25 MiB），可选一份数据契约 YAML。没有契约时仅做观测。',
      )}
      className="h-full"
      bodyClassName="flex flex-col gap-3 p-3"
    >
      <DropZone
        file={csv}
        onFile={(next) => {
          setCsv(next);
          setEncoding('reading');
          setError(null);
        }}
        accept=".csv,text/csv"
        extensions={['.csv']}
        title={t('CSV dataset', 'CSV 数据集')}
        hint={t('Drop a file here or click to choose', '拖放文件到此处，或点击选择')}
        disabled={!available || pending}
      >
        <span className="inline-flex items-center gap-1.5 text-xs">
          <span className="text-muted-foreground">{t('Encoding hint', '编码提示')}</span>
          <Pill variant={enc.tone === 'neutral' ? 'neutral' : enc.tone === 'review' ? 'review' : 'blocker'}>{enc.text}</Pill>
        </span>
      </DropZone>
      <DropZone
        file={contract}
        onFile={(next) => {
          setContract(next);
          setError(null);
        }}
        accept=".yaml,.yml,application/x-yaml,text/yaml"
        extensions={['.yaml', '.yml']}
        title={t('Data Contract YAML (optional)', '数据契约 YAML（可选）')}
        hint={t('v2 contract, or a v1 policy file; ≤ 64 KiB', 'v2 契约或 v1 policy 文件；≤ 64 KiB')}
        disabled={!available || pending}
        compact
      />
      <div className="text-[11px] leading-4 text-muted-foreground">
        {t(
          'The encoding hint is computed in the browser from the first 4 KiB and is informational. The engine hashes the original bytes and reports the encoding it actually used.',
          '编码提示由浏览器根据前 4 KiB 计算，仅供参考。引擎对原始字节计算哈希，并报告实际使用的编码。',
        )}
      </div>
      {error ? <GuardRow error={error} /> : null}
      <div className="mt-auto flex items-center justify-between gap-3 border-t border-border pt-3">
        <span className="mono text-[11px] text-muted-foreground">
          {pending ? 'POST /v1/runs …' : csv ? `POST /v1/runs · ${contract ? 'file + policy' : 'file'}` : ''}
        </span>
        <Button size="sm" disabled={!available || !csv || pending} onClick={() => void submit()}>
          {pending ? t('Uploading', '上传中') : t('Start analysis', '开始分析')}
        </Button>
      </div>
    </PanelSection>
  );
}

// ---------------------------------------------------------------------------
// Samples
// ---------------------------------------------------------------------------

type SamplePending = { id: string; withContract: boolean } | null;

function SampleCard({
  sample,
  pending,
  disabled,
  onStart,
}: {
  sample: SampleInfo;
  pending: SamplePending;
  disabled: boolean;
  onStart: (withContract: boolean) => void;
}) {
  const { t, language } = useLanguage();
  const mine = pending?.id === sample.id ? pending : null;
  return (
    <li className="flex flex-col gap-2 rounded-md border border-border bg-background p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <div className="min-w-0">
          <div className="text-[13px] font-semibold leading-5">{pick(language, sample.title_zh, sample.title_en)}</div>
          <div className="mono text-[11px] text-muted-foreground">{sample.id}</div>
        </div>
        <div className="mono text-xs text-muted-foreground">
          {formatInt(sample.rows)} × {formatInt(sample.columns)}
        </div>
      </div>
      <p className="text-xs leading-4 text-muted-foreground">{pick(language, sample.description_zh, sample.description_en)}</p>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-1">
          {sample.tags.map((tag) => (
            <Pill key={tag}>{tag}</Pill>
          ))}
          {!sample.has_contract ? <Pill variant="review">{t('No bundled contract', '无自带契约')}</Pill> : null}
        </div>
        <div className="flex items-center gap-1.5">
          <Button
            size="xs"
            disabled={disabled || !sample.has_contract}
            title={sample.has_contract ? undefined : t('This sample ships no contract', '该样例没有自带契约')}
            onClick={() => onStart(true)}
          >
            {mine?.withContract ? t('Starting', '启动中') : t('Analyse with contract', '带契约分析')}
          </Button>
          <Button size="xs" variant="outline" disabled={disabled} onClick={() => onStart(false)}>
            {mine && !mine.withContract ? t('Starting', '启动中') : t('Observe only', '仅观测')}
          </Button>
        </div>
      </div>
    </li>
  );
}

function SamplesPanel({ available }: { available: boolean }) {
  const { t } = useLanguage();
  const router = useRouter();
  const [tick, setTick] = useState(0);
  const samples = useApiList(listSamples, available, tick);
  const [pending, setPending] = useState<SamplePending>(null);
  const [error, setError] = useState<ApiError | null>(null);

  const start = async (sample: SampleInfo, withContract: boolean) => {
    if (pending) return;
    setPending({ id: sample.id, withContract });
    setError(null);
    try {
      const created = await createRunFromSample(sample.id, withContract);
      router.push(`/runs/${encodeURIComponent(created.run_id)}`);
    } catch (reason) {
      setError(toApiError(reason));
      setPending(null);
    }
  };

  return (
    <PanelSection
      id="samples"
      title={t('Sample datasets', '样例数据')}
      description={t(
        'Deterministic generators with planted issues; every sample carries a v2 contract.',
        '确定性生成、预埋问题的数据集；每个样例附带 v2 契约。',
      )}
      className="h-full"
      bodyClassName="flex flex-col gap-2 p-3"
      actions={
        <Button size="xs" variant="ghost" disabled={!available || samples.loading} onClick={() => setTick((n) => n + 1)}>
          <RefreshCw data-icon="inline-start" aria-hidden="true" />
          {t('Refresh', '刷新')}
        </Button>
      }
    >
      {!available ? (
        <div className="text-xs text-muted-foreground">{t('Samples are served by the local API.', '样例由本地 API 提供。')}</div>
      ) : null}
      {samples.loading && !samples.data ? <InFlight method="GET" path="/v1/samples" /> : null}
      {samples.error ? <GuardRow error={samples.error} /> : null}
      {error ? (
        <div className="flex flex-col gap-1">
          <span className="mono text-[11px] text-muted-foreground">POST /v1/runs/from-sample</span>
          <GuardRow error={error} />
        </div>
      ) : null}
      {pending ? (
        <InFlight method="POST" path={`/v1/runs/from-sample · ${pending.id} · with_contract=${pending.withContract}`} />
      ) : null}
      {samples.data ? (
        samples.data.length === 0 ? (
          <div className="text-xs text-muted-foreground">{t('The API registered no samples.', 'API 未注册任何样例。')}</div>
        ) : (
          <ul className="flex flex-col gap-2">
            {samples.data.map((sample) => (
              <SampleCard
                key={sample.id}
                sample={sample}
                pending={pending}
                disabled={pending !== null}
                onStart={(withContract) => void start(sample, withContract)}
              />
            ))}
          </ul>
        )
      ) : null}
    </PanelSection>
  );
}

// ---------------------------------------------------------------------------
// Recent runs
// ---------------------------------------------------------------------------

function byCreatedDesc(a: RunSummary, b: RunSummary): number {
  return b.created_at.localeCompare(a.created_at);
}

function RecentRunsPanel({ available }: { available: boolean }) {
  const { t, language } = useLanguage();
  const router = useRouter();
  const [tick, setTick] = useState(0);
  const runs = useApiList(listRuns, available, tick);
  const [resetOpen, setResetOpen] = useState(false);
  const [resetPending, setResetPending] = useState(false);
  const [resetError, setResetError] = useState<ApiError | null>(null);
  const [lastReset, setLastReset] = useState<number | null>(null);

  const refresh = () => setTick((n) => n + 1);

  const reset = async () => {
    setResetPending(true);
    setResetError(null);
    try {
      const result = await cleanupRuns(0);
      setLastReset(result.deleted);
      setResetOpen(false);
      refresh();
    } catch (reason) {
      setResetError(toApiError(reason));
    } finally {
      setResetPending(false);
    }
  };

  const all = runs.data ? [...runs.data].sort(byCreatedDesc) : [];
  const rows = all.slice(0, RECENT_LIMIT);

  const columns: DataTableColumn<RunSummary>[] = [
    {
      key: 'run_id',
      header: t('Run', '运行'),
      render: (row) => (
        <Link
          href={`/runs/${encodeURIComponent(row.run_id)}`}
          className="mono text-xs text-foreground underline-offset-2 hover:underline"
          onClick={(event) => event.stopPropagation()}
        >
          {row.run_id}
        </Link>
      ),
    },
    {
      key: 'source_name',
      header: t('Source', '来源文件'),
      render: (row) => (
        <span className="inline-block max-w-56 truncate align-bottom" title={row.source_name}>
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
    {
      key: 'contract_source',
      header: t('Contract', '契约'),
      render: (row) => label('contract_source', row.contract_source, language),
    },
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
  ];

  return (
    <PanelSection
      id="recent-runs"
      title={t('Recent runs', '最近运行')}
      description={
        runs.data
          ? t(`Showing ${rows.length} of ${all.length}`, `显示 ${rows.length} / ${all.length} 条`)
          : t('Runs are read from the run store on disk.', '运行记录来自磁盘上的运行存储。')
      }
      flush
      actions={
        <>
          {lastReset !== null ? (
            <span className="mono text-[11px] text-muted-foreground">
              {t('deleted', '已删除')} {formatInt(lastReset)}
            </span>
          ) : null}
          <Button size="xs" variant="ghost" disabled={!available || runs.loading} onClick={refresh}>
            <RefreshCw data-icon="inline-start" aria-hidden="true" />
            {t('Refresh', '刷新')}
          </Button>
          <Button size="xs" variant="outline" disabled={!available} onClick={() => setResetOpen(true)}>
            {t('Reset demo', '重置演示')}
          </Button>
          <Button size="xs" variant="ghost" nativeButton={false} render={<Link href="/runs" />}>
            {t('All runs', '全部记录')}
          </Button>
        </>
      }
    >
      {runs.loading && !runs.data ? <InFlight method="GET" path="/v1/runs" /> : null}
      {runs.error ? <GuardRow error={runs.error} className="m-3" /> : null}
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(row) => row.run_id}
        onRowClick={(row) => router.push(`/runs/${encodeURIComponent(row.run_id)}`)}
        ariaLabel={t('Recent runs', '最近运行')}
        className="rounded-none border-0"
        emptyTitle={available ? t('No runs yet', '暂无运行记录') : t('Live API not connected', '未连接实时 API')}
        emptyDescription={
          available
            ? t('Upload a CSV or start a sample to create the first run.', '上传 CSV 或启动样例即可创建第一条运行。')
            : t('Run history is only available with the local API.', '运行记录仅在连接本地 API 时可用。')
        }
      />
      <ConfirmDialog
        open={resetOpen}
        onOpenChange={(open) => {
          setResetOpen(open);
          if (!open) setResetError(null);
        }}
        title={t('Reset the demo', '重置演示')}
        description={t(
          'Deletes every run in the run store, including sample-seeded ones. Source files, reports, manifests and ledgers of those runs are removed. This cannot be undone.',
          '删除运行存储中的全部运行记录，包括样例生成的运行。相关源文件、报告、清单与账本一并移除。此操作不可撤销。',
        )}
        confirmLabel={t('Delete all runs', '删除全部运行')}
        destructive
        pending={resetPending}
        onConfirm={reset}
      >
        <div className="flex flex-col gap-2">
          <div className="mono text-xs text-muted-foreground">DELETE /v1/runs?older_than_minutes=0</div>
          {resetError ? <GuardRow error={resetError} /> : null}
        </div>
      </ConfirmDialog>
    </PanelSection>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function WorkbenchPage() {
  const { t } = useLanguage();
  const available = useLiveApiAvailable();

  return (
    <div className="mx-auto flex w-full max-w-[1600px] flex-col gap-4 px-4 py-4 lg:px-6">
      <header className="flex flex-col gap-0.5">
        <h1 className="text-base font-semibold leading-6">{t('Dataset release workbench', '数据发布工作台')}</h1>
        <p className="text-[13px] leading-5 text-muted-foreground">
          {t(
            'AI proposes · policy decides · humans approve · rules execute · hashes reconcile',
            'AI 提议 · 策略决策 · 人工拍板 · 规则执行 · 哈希对账',
          )}
        </p>
      </header>

      {!available ? (
        <InlineAlert
          variant="info"
          title={t('Replay-only deployment', '当前为仅回放部署')}
          actions={
            <Button size="xs" variant="outline" nativeButton={false} render={<Link href="/demo/clinical-nlp" />}>
              {t('Open offline replay', '打开离线回放')}
            </Button>
          }
        >
          {t(
            'Live analysis needs the local API (FastAPI on 127.0.0.1:8000, or NEXT_PUBLIC_API_BASE_URL). This published site can only show the recorded clinical replay.',
            '实时分析需要本地 API（127.0.0.1:8000 上的 FastAPI，或配置 NEXT_PUBLIC_API_BASE_URL）。当前发布站点只能展示已录制的临床样例回放。',
          )}
        </InlineAlert>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <NewAssessmentCard available={available} />
        <SamplesPanel available={available} />
      </div>

      <RecentRunsPanel available={available} />
    </div>
  );
}
