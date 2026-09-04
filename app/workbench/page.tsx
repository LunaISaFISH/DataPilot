'use client';

import { FileText, RefreshCw, Upload } from 'lucide-react';
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
      title={t('Run your CSV', '分析你的 CSV')}
      description={t(
        'Choose a CSV to start. Add a data contract for a full release review, or leave it out for a quick scan.',
        '选择一份 CSV 开始。添加数据契约可完成发布审核；不添加则进行快速扫描。',
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
      <div className="text-[11px] leading-4 text-muted-foreground">
        {t(
          'We preview the file encoding in your browser. The analysis keeps the original file unchanged.',
          '浏览器会先检查文件编码；分析过程中不会改动你的原始文件。',
        )}
      </div>
      {error ? <GuardRow error={error} /> : null}
      <div className="mt-auto flex items-center justify-between gap-3 border-t border-border pt-3">
        <span className="mono text-[11px] text-muted-foreground">
          {pending
            ? t('Preparing your analysis…', '正在准备分析…')
            : csv
              ? contract
                ? t('Ready for full review', '可以开始完整审核')
                : t('Ready for a quick scan', '可以开始快速扫描')
              : ''}
        </span>
        <Button size="sm" disabled={!available || !csv || pending} onClick={() => void submit()}>
          {pending ? t('Starting…', '正在启动…') : t('Start analysis', '开始分析')}
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
            {mine?.withContract ? t('Starting…', '启动中…') : t('Full review', '完整审核')}
          </Button>
          <Button
            size="xs"
            variant="outline"
            disabled={disabled}
            title={t('Find visible issues without changing data or calling AI', '只查找可见问题，不修改数据，也不调用 AI')}
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

  return (
    <PanelSection
      id="samples"
      title={t('Sample datasets', '样例数据')}
      description={t(
        'Try the complete workflow with four ready-to-use datasets, including real public retail data.',
        '用四份现成数据体验完整流程，其中包含真实公开零售数据。',
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
      {samples.data ? (
        samples.data.length === 0 ? (
          <div className="text-xs text-muted-foreground">{t('No samples are available right now.', '当前没有可用样例。')}</div>
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
// Page
// ---------------------------------------------------------------------------

export default function WorkbenchPage() {
  const { t } = useLanguage();
  const available = useLiveApiAvailable();

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 px-4 py-7 sm:px-6 sm:py-10">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
        <h1 className="text-xl font-semibold tracking-[-0.03em] sm:text-2xl">{t('Start a real analysis', '开始一次真实分析')}</h1>
        <p className="text-[13px] leading-5 text-muted-foreground">
          {t(
            'Use your own CSV, or open a sample below. Need an instant walkthrough? The 3-minute demo is always ready.',
            '上传自己的 CSV，或从下方选择样例。如果想快速了解流程，3 分钟演示随时可用。',
          )}
        </p>
        </div>
        <Link href="/runs" className="min-h-11 self-start py-3 text-xs font-medium text-foreground underline-offset-4 hover:underline sm:self-auto">
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

      <details id="samples" className="group overflow-hidden rounded-lg border border-border bg-card">
        <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-4 px-4 marker:hidden">
          <div>
            <div className="text-sm font-semibold">{t('Try a sample dataset', '试用样例数据')}</div>
            <div className="mt-0.5 text-xs text-muted-foreground">
              {t('Runs the real analysis service; larger samples can take a moment.', '会使用真实分析服务；较大样例可能需要稍等。')}
            </div>
          </div>
          <span className="text-xs font-medium text-policy group-open:hidden">{t('Show', '展开')}</span>
          <span className="hidden text-xs font-medium text-policy group-open:inline">{t('Hide', '收起')}</span>
        </summary>
        <div className="border-t border-border p-3">
          <SamplesPanel available={available} />
        </div>
      </details>
    </div>
  );
}
