'use client';

import { ArrowRight, CheckCircle2, FileText, RefreshCw, Upload } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useRef, useState } from 'react';

import { GuardRow, InlineAlert, PanelSection, Pill } from '@/components/datapilot';
import { Button } from '@/components/ui/button';
import {
  ApiError,
  createRun,
  createRunFromSample,
  listSamples,
  useLiveApiAvailable,
} from '@/lib/api';
import { formatBytes, formatInt } from '@/lib/format';
import { pick, useLanguage } from '@/lib/language';
import type { SampleInfo } from '@/lib/types';
import { cn } from '@/lib/utils';

// ---------------------------------------------------------------------------
// Small shared helpers (local to this page)
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

/** The request currently in flight, shown instead of a spinner. */
function InFlight({ method, path }: { method: string; path: string }) {
  const { t } = useLanguage();
  return (
    <div className="px-3 py-2 text-xs text-muted-foreground" aria-live="polite" title={`${method} ${path}`}>
      {t('Preparing…', '正在准备…')}
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
          'flex w-full cursor-pointer flex-col items-start justify-center gap-1.5 rounded-xl border border-dashed px-4 text-left transition-colors',
          compact ? 'min-h-20 py-3' : 'min-h-32 py-5 sm:min-h-36',
          dragging ? 'border-policy bg-policy-tint' : 'border-black/10 bg-[#f7faf8] hover:border-policy/30 hover:bg-policy-tint/35',
          'disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-background',
        )}
      >
        <span className="flex items-center gap-2.5 text-sm font-semibold text-ink">
          {compact ? <FileText aria-hidden="true" className="size-4 text-policy" /> : <Upload aria-hidden="true" className="size-5 text-policy" />}
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
      title={t('Run your CSV', '分析你的 CSV')}
      description={t(
        'Choose a CSV to start. Add a data contract for a full release review, or leave it out for a quick scan.',
        '选择一份 CSV 开始。添加数据契约可完成发布审核；不添加则进行快速扫描。',
      )}
      className="h-full overflow-hidden border-black/8 shadow-[0_18px_60px_rgba(16,35,30,0.06)]"
      bodyClassName="flex flex-col gap-4 p-5 sm:p-6"
    >
      <div className="grid gap-3 md:grid-cols-[minmax(0,1.25fr)_minmax(16rem,0.75fr)]">
        <DropZone
          file={csv}
          onFile={(next) => {
            setCsv(next);
            setEncoding('reading');
            setError(null);
          }}
          accept=".csv,text/csv"
          extensions={['.csv']}
          title={t('Choose a CSV', '选择 CSV 文件')}
          hint={t('Drop it here, or tap to browse · up to 25 MiB', '拖到这里，或点击选择 · 最大 25 MiB')}
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
          title={t('Add a data contract (optional)', '添加数据契约（可选）')}
          hint={t('YAML · up to 64 KiB', 'YAML 文件 · 最大 64 KiB')}
          disabled={!available || pending}
          compact
        />
      </div>
      <div className="text-[11px] leading-4 text-muted-foreground">
        {t(
          'We preview the file encoding in your browser. The analysis keeps the original file unchanged.',
          '浏览器会先检查文件编码；分析过程中不会改动你的原始文件。',
        )}
      </div>
      {error ? <GuardRow error={error} /> : null}
      <div className="mt-auto flex flex-col gap-3 border-t border-black/7 pt-4 sm:flex-row sm:items-center sm:justify-between">
        <span className="mono text-[11px] text-muted-foreground">
          {pending
            ? t('Preparing your analysis…', '正在准备分析…')
            : csv
              ? contract
                ? t('Ready for full review', '可以开始完整审核')
                : t('Ready for a quick scan', '可以开始快速扫描')
              : ''}
        </span>
        <Button className="min-h-11 justify-between rounded-xl px-4 sm:justify-center" size="lg" disabled={!available || !csv || pending} onClick={() => void submit()}>
          {pending ? t('Starting…', '正在启动…') : t('Start analysis', '开始分析')}
          {!pending ? <ArrowRight aria-hidden="true" /> : null}
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
  const featured = sample.tags.includes('real-data');
  return (
    <li className={cn('flex flex-col gap-3 rounded-xl border p-4', featured ? 'border-policy/20 bg-policy-tint/25' : 'border-black/8 bg-[#fbfcfa]')}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <div className="min-w-0">
          <div className="text-[13px] font-semibold leading-5">{pick(language, sample.title_zh, sample.title_en)}</div>
          <div className="mono text-[11px] text-muted-foreground">{sample.id}</div>
        </div>
        <div className="mono text-xs text-muted-foreground">
          {formatInt(sample.rows)} × {formatInt(sample.columns)}
        </div>
      </div>
      <p className="line-clamp-2 text-xs leading-5 text-muted-foreground">{pick(language, sample.description_zh, sample.description_en)}</p>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-1">
          {sample.tags.map((tag) => (
            <Pill key={tag}>{tag}</Pill>
          ))}
          {!sample.has_contract ? <Pill variant="review">{t('No bundled contract', '无自带契约')}</Pill> : null}
        </div>
        <div className="flex items-center gap-1.5">
          <Button
            size="sm"
            className="min-h-9 rounded-lg px-3"
            disabled={disabled || !sample.has_contract}
            title={sample.has_contract ? undefined : t('This sample ships no contract', '该样例没有自带契约')}
            onClick={() => onStart(true)}
          >
            {mine?.withContract ? t('Starting…', '启动中…') : t('Full review', '完整审核')}
          </Button>
          <Button
            size="sm"
            className="min-h-9 rounded-lg px-3"
            variant="outline"
            disabled={disabled}
            title={t('Get a fast view of the issues in this dataset', '快速了解这份数据中的问题')}
            onClick={() => onStart(false)}
          >
            {mine && !mine.withContract ? t('Starting…', '启动中…') : t('Quick scan', '快速扫描')}
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

  const orderedSamples = samples.data
    ? [...samples.data].sort((left, right) => Number(right.tags.includes('real-data')) - Number(left.tags.includes('real-data')))
    : null;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-ink">{t('Choose a dataset', '选择一份数据')}</h2>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            {t('Start with real public retail data, or explore one of the synthetic industry examples.', '可先体验真实公开零售数据，也可以选择其他行业合成样例。')}
          </p>
        </div>
        <Button size="sm" variant="ghost" disabled={!available || samples.loading} onClick={() => setTick((n) => n + 1)}>
          <RefreshCw data-icon="inline-start" aria-hidden="true" />
          {t('Refresh', '刷新')}
        </Button>
      </div>
      {!available ? (
        <div className="text-xs text-muted-foreground">{t('Connect to the live service to open a sample.', '连接实时服务后即可打开样例。')}</div>
      ) : null}
      {samples.loading && !samples.data ? <InFlight method="GET" path="/v1/samples" /> : null}
      {samples.error ? <GuardRow error={samples.error} /> : null}
      {error ? (
        <div className="flex flex-col gap-1">
          <GuardRow error={error} />
        </div>
      ) : null}
      {pending ? (
        <InFlight method="POST" path={`/v1/runs/from-sample · ${pending.id} · with_contract=${pending.withContract}`} />
      ) : null}
      {orderedSamples ? (
        orderedSamples.length === 0 ? (
          <div className="text-xs text-muted-foreground">{t('No samples are available right now.', '当前没有可用样例。')}</div>
        ) : (
          <ul className="grid gap-3 lg:grid-cols-2">
            {orderedSamples.map((sample) => (
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
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function WorkbenchPage() {
  const { t } = useLanguage();
  const available = useLiveApiAvailable();

  return (
    <div className="min-h-[calc(100dvh-var(--shell-header-height)-var(--shell-status-height))] bg-[linear-gradient(180deg,#f7f8f5_0%,#eef3f1_72%)]">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 pt-7 pb-16 sm:px-8 sm:pt-10 lg:px-10">
        <header className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="mb-3 inline-flex items-center gap-1.5 rounded-full border border-policy/20 bg-policy-tint px-3 py-1.5 text-xs font-medium text-policy">
              <CheckCircle2 aria-hidden="true" className="size-3.5" />
              {t('Ready for real data', '可分析真实数据')}
            </div>
            <h1 className="text-2xl font-semibold tracking-[-0.04em] text-ink sm:text-3xl">{t('Start a new analysis', '开始新的数据分析')}</h1>
            <p className="mt-2 max-w-2xl text-[13px] leading-6 text-muted-foreground sm:text-sm">
              {t(
                'Upload a CSV to understand its quality, review uncertain values, and prepare a safer dataset for downstream use.',
                '上传一份 CSV，了解数据质量、审核不确定取值，并为下游使用准备一份更可靠的数据。',
              )}
            </p>
          </div>
          <Link
            href="/runs"
            className="inline-flex min-h-11 items-center gap-2 self-start rounded-xl border border-black/8 bg-white px-4 text-xs font-medium text-foreground shadow-[0_8px_24px_rgba(16,35,30,0.04)] transition-colors hover:bg-muted/50 sm:self-auto"
          >
            {t('View previous analyses', '查看历史分析')} →
          </Link>
        </header>

        {!available ? (
          <InlineAlert
            variant="info"
            title={t('Live analysis is temporarily unavailable', '实时分析暂时不可用')}
            actions={
              <Button size="xs" variant="outline" nativeButton={false} render={<Link href="/demo" />}>
                {t('Open the instant demo', '打开即时演示')}
              </Button>
            }
          >
            {t(
              'Check the service address, or continue with the verified demo while the connection recovers.',
              '请检查服务地址；连接恢复前，也可以继续使用已验证演示。',
            )}
          </InlineAlert>
        ) : null}

        <NewAssessmentCard available={available} />

        <details id="samples" className="group overflow-hidden rounded-2xl border border-black/8 bg-white shadow-[0_18px_60px_rgba(16,35,30,0.05)]">
          <summary className="flex min-h-16 cursor-pointer list-none items-center justify-between gap-4 px-5 py-2 marker:hidden sm:px-6">
            <div>
              <div className="text-sm font-semibold">{t('Try a sample dataset', '试用样例数据')}</div>
              <div className="mt-0.5 text-xs text-muted-foreground">
                {t('Explore the same workflow with a prepared dataset.', '用准备好的数据体验同一套分析流程。')}
              </div>
            </div>
            <span className="text-xs font-medium text-policy group-open:hidden">{t('Show', '展开')}</span>
            <span className="hidden text-xs font-medium text-policy group-open:inline">{t('Hide', '收起')}</span>
          </summary>
          <div className="border-t border-black/7 p-5 sm:p-6">
            <SamplesPanel available={available} />
          </div>
        </details>
      </div>
    </div>
  );
}
