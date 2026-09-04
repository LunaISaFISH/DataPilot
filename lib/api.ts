'use client';

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import { recordApiLog, serializeBody, type ApiLogError } from '@/lib/api-log';
import type {
  AICallRecord,
  AiContract,
  ApiErrorBody,
  ApplyRequest,
  ArtifactInfo,
  ArtifactName,
  CleanupResult,
  ContractDraftResult,
  ContractDraftStarted,
  ContractView,
  DecisionInput,
  DecisionsResponse,
  DryRunResponse,
  ExecutionResult,
  FindingRecords,
  HealthInfo,
  RedteamCase,
  RedteamResult,
  ReleaseBrief,
  ReplayCreated,
  RunCreated,
  RunDetail,
  RunEvent,
  RunSummary,
  SampleInfo,
  SemanticRerunResult,
  TamperTestResult,
  VerifyReport,
} from '@/lib/types';

// ---------------------------------------------------------------------------
// Base URL resolution
// ---------------------------------------------------------------------------

const configuredApiBase = process.env.NEXT_PUBLIC_API_BASE_URL?.replace(/\/$/, '') || null;

function isLocalBrowser(): boolean {
  if (typeof window === 'undefined') return false;
  const host = window.location.hostname;
  return host === 'localhost' || host === '127.0.0.1';
}

/** `NEXT_PUBLIC_API_BASE_URL`, else `http://localhost:8000` on localhost, else null (replay only). */
export function resolveApiBase(): string | null {
  if (configuredApiBase) return configuredApiBase;
  return isLocalBrowser() ? 'http://localhost:8000' : null;
}

function subscribeNoop() {
  return () => undefined;
}

/** True when a live API base can be resolved in this browser. Stable across SSR/hydration. */
export function useLiveApiAvailable(): boolean {
  return useSyncExternalStore(
    subscribeNoop,
    () => Boolean(configuredApiBase || isLocalBrowser()),
    () => Boolean(configuredApiBase),
  );
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class ApiError extends Error {
  readonly code: string;
  readonly message_zh: string;
  readonly message_en: string;
  readonly retryable: boolean;
  readonly correlation_id: string | null;
  readonly status: number;
  /** Governance 409 bodies: the value the server saw (e.g. the current hash). */
  readonly observed: unknown;
  /** Governance 409 bodies: the value the client sent or the server expected. */
  readonly expected: unknown;

  constructor(init: {
    code: string;
    message_zh: string;
    message_en: string;
    retryable?: boolean;
    correlation_id?: string | null;
    status: number;
    observed?: unknown;
    expected?: unknown;
  }) {
    super(init.message_en || init.message_zh || init.code);
    this.name = 'ApiError';
    this.code = init.code;
    this.message_zh = init.message_zh;
    this.message_en = init.message_en;
    this.retryable = init.retryable ?? false;
    this.correlation_id = init.correlation_id ?? null;
    this.status = init.status;
    this.observed = init.observed;
    this.expected = init.expected;
  }

  /** Structured body for the API log drawer. */
  toLogError(): ApiLogError {
    return {
      code: this.code,
      message_zh: this.message_zh,
      message_en: this.message_en,
      retryable: this.retryable,
      correlation_id: this.correlation_id,
      observed: this.observed,
      expected: this.expected,
    };
  }

  /** Message in the requested language, falling back to the other one. */
  localized(language: 'zh' | 'en'): string {
    const primary = language === 'zh' ? this.message_zh : this.message_en;
    const secondary = language === 'zh' ? this.message_en : this.message_zh;
    return primary || secondary || this.code;
  }
}

function isApiErrorBody(value: unknown): value is ApiErrorBody {
  if (typeof value !== 'object' || value === null) return false;
  const error = (value as { error?: unknown }).error;
  return typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string';
}

function toApiError(response: Response, body: unknown, correlationHeader: string | null): ApiError {
  if (isApiErrorBody(body)) {
    return new ApiError({
      ...body.error,
      correlation_id: body.error.correlation_id || correlationHeader,
      status: response.status,
    });
  }
  // Legacy FastAPI `{detail}` shape, kept so old endpoints still surface a message.
  const detail = (body as { detail?: unknown } | null)?.detail;
  const message =
    typeof detail === 'string'
      ? detail
      : typeof detail === 'object' && detail !== null && typeof (detail as { message?: unknown }).message === 'string'
        ? (detail as { message: string }).message
        : response.statusText || `HTTP ${response.status}`;
  return new ApiError({
    code: `HTTP_${response.status}`,
    message_zh: message,
    message_en: message,
    retryable: response.status >= 500,
    correlation_id: correlationHeader,
    status: response.status,
  });
}

export function noApiError(): ApiError {
  return new ApiError({
    code: 'NO_API_BASE',
    message_zh: '当前部署未连接实时 API。',
    message_en: 'No live API is connected to this deployment.',
    retryable: false,
    status: 0,
  });
}

function networkError(reason: unknown): ApiError {
  const detail = reason instanceof Error ? reason.message : String(reason);
  return new ApiError({
    code: 'NETWORK_ERROR',
    message_zh: `无法连接分析服务（${detail}）。`,
    message_en: `The analysis service could not be reached (${detail}).`,
    retryable: true,
    status: 0,
  });
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

type RequestOptions = {
  method?: HttpMethod;
  json?: unknown;
  form?: FormData;
  headers?: Record<string, string>;
  signal?: AbortSignal;
};

/** Response metadata every call exposes to the API log and to callers that need it. */
export type ResponseMeta = {
  status: number;
  correlationId: string | null;
  /** `Server-Timing: total;dur=<ms>` (falls back to the first `dur` metric). */
  serverMs: number | null;
  clientMs: number;
  /** `X-Idempotent-Replay: true` — the server returned a stored result for a repeated key. */
  idempotentReplay: boolean;
};

export type ResponseWithMeta<T> = { data: T; meta: ResponseMeta };

function requireBase(): string {
  const base = resolveApiBase();
  if (!base) throw noApiError();
  return base;
}

/** Parse `Server-Timing` (RFC 9210 style): prefer the `total` metric, else the first `dur`. */
export function parseServerTiming(header: string | null | undefined): number | null {
  if (!header) return null;
  let first: number | null = null;
  for (const metric of header.split(',')) {
    const [rawName, ...params] = metric.split(';').map((part) => part.trim());
    const dur = params.find((param) => param.toLowerCase().startsWith('dur='));
    if (!dur) continue;
    const value = Number(dur.slice(4));
    if (!Number.isFinite(value)) continue;
    if ((rawName ?? '').toLowerCase() === 'total') return value;
    if (first === null) first = value;
  }
  return first;
}

function readMeta(response: Response, clientMs: number): ResponseMeta {
  const replay = response.headers.get('X-Idempotent-Replay');
  return {
    status: response.status,
    correlationId: response.headers.get('X-Correlation-Id'),
    serverMs: parseServerTiming(response.headers.get('Server-Timing')),
    clientMs,
    idempotentReplay: replay !== null && replay.toLowerCase() === 'true',
  };
}

/** Log-safe description of a multipart body: names, sizes and types only, never file bytes. */
function describeForm(form: FormData): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  form.forEach((value, key) => {
    fields[key] =
      typeof value === 'string'
        ? value.length > 256
          ? `${value.slice(0, 256)}… (${value.length} chars)`
          : value
        : { file: value.name, bytes: value.size, type: value.type || null };
  });
  return { multipart: fields };
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

async function requestWithMeta<T>(path: string, options: RequestOptions = {}): Promise<ResponseWithMeta<T>> {
  const method: HttpMethod = options.method ?? 'GET';
  const base = requireBase();
  const headers: Record<string, string> = { Accept: 'application/json', ...options.headers };
  let body: BodyInit | undefined;
  let requestBody: string | null = null;
  if (options.form) {
    body = options.form;
    requestBody = serializeBody(describeForm(options.form));
  } else if (options.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.json);
    requestBody = serializeBody(options.json);
  }
  const started = now();
  let response: Response;
  try {
    response = await fetch(`${base}${path}`, { method, headers, body, signal: options.signal });
  } catch (reason) {
    if (reason instanceof DOMException && reason.name === 'AbortError') throw reason;
    const error = networkError(reason);
    recordApiLog({
      kind: 'http',
      method,
      path,
      status: 0,
      serverMs: null,
      clientMs: Math.round(now() - started),
      correlationId: null,
      idempotentReplay: false,
      requestBody,
      responseBody: null,
      error: error.toLogError(),
      note: null,
    });
    throw error;
  }
  const text = response.status === 204 ? '' : await response.text();
  const meta = readMeta(response, Math.round(now() - started));
  let parsed: unknown = undefined;
  let parseFailed = false;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parseFailed = true;
    }
  }
  const log = (error: ApiError | null) =>
    recordApiLog({
      kind: 'http',
      method,
      path,
      status: meta.status,
      serverMs: meta.serverMs,
      clientMs: meta.clientMs,
      correlationId: meta.correlationId,
      idempotentReplay: meta.idempotentReplay,
      requestBody,
      responseBody: parseFailed ? serializeBody(text) : serializeBody(parsed),
      error: error ? error.toLogError() : null,
      note: null,
    });
  if (!response.ok) {
    const error = toApiError(response, parseFailed ? null : parsed, meta.correlationId);
    log(error);
    throw error;
  }
  if (parseFailed) {
    const error = new ApiError({
      code: 'INVALID_JSON',
      message_zh: '服务返回了无法解析的响应。',
      message_en: 'The service returned a response that could not be parsed.',
      retryable: false,
      correlation_id: meta.correlationId,
      status: response.status,
    });
    log(error);
    throw error;
  }
  log(null);
  return { data: parsed as T, meta };
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { data } = await requestWithMeta<T>(path, options);
  return data;
}

// ---------------------------------------------------------------------------
// Endpoints (spec §7)
// ---------------------------------------------------------------------------

export function getHealth(signal?: AbortSignal): Promise<HealthInfo> {
  return request<HealthInfo>('/health', { signal });
}

export function listSamples(signal?: AbortSignal): Promise<SampleInfo[]> {
  return request<SampleInfo[]>('/v1/samples', { signal });
}

export function createRun(file: File, policyFile?: File | null): Promise<RunCreated> {
  const form = new FormData();
  form.append('file', file);
  if (policyFile) form.append('policy', policyFile);
  return request<RunCreated>('/v1/runs', { method: 'POST', form });
}

export function createRunFromSample(sampleId: string, withContract: boolean): Promise<RunCreated> {
  return request<RunCreated>('/v1/runs/from-sample', {
    method: 'POST',
    json: { sample_id: sampleId, with_contract: withContract },
  });
}

export function listRuns(signal?: AbortSignal): Promise<RunSummary[]> {
  return request<RunSummary[]>('/v1/runs', { signal });
}

export function getRun(runId: string, signal?: AbortSignal): Promise<RunDetail> {
  return request<RunDetail>(`/v1/runs/${encodeURIComponent(runId)}`, { signal });
}

export function draftContract(runId: string): Promise<ContractDraftStarted> {
  return request<ContractDraftStarted>(`/v1/runs/${encodeURIComponent(runId)}/contract/draft`, {
    method: 'POST',
  });
}

export function getContractDraft(runId: string, signal?: AbortSignal): Promise<ContractDraftResult> {
  return request<ContractDraftResult>(`/v1/runs/${encodeURIComponent(runId)}/contract/draft`, { signal });
}

export function putContract(runId: string, yaml: string): Promise<RunCreated> {
  return request<RunCreated>(`/v1/runs/${encodeURIComponent(runId)}/contract`, {
    method: 'PUT',
    json: { yaml },
  });
}

export function getContract(runId: string, signal?: AbortSignal): Promise<ContractView> {
  return request<ContractView>(`/v1/runs/${encodeURIComponent(runId)}/contract`, { signal });
}

export function getFindingRecords(
  runId: string,
  findingId: string,
  limit = 20,
  signal?: AbortSignal,
): Promise<FindingRecords> {
  const query = new URLSearchParams({ limit: String(limit) });
  return request<FindingRecords>(
    `/v1/runs/${encodeURIComponent(runId)}/findings/${encodeURIComponent(findingId)}/records?${query}`,
    { signal },
  );
}

export function putDecisions(runId: string, decisions: DecisionInput[]): Promise<DecisionsResponse> {
  return request<DecisionsResponse>(`/v1/runs/${encodeURIComponent(runId)}/decisions`, {
    method: 'PUT',
    json: { decisions },
  });
}

export function createDryRun(runId: string): Promise<DryRunResponse> {
  return request<DryRunResponse>(`/v1/runs/${encodeURIComponent(runId)}/dry-run`, { method: 'POST' });
}

/**
 * Execute the approved change set. The idempotency key is sent both in the body and as the
 * `Idempotency-Key` header; a repeated key returns the stored result with `X-Idempotent-Replay`.
 */
export function applyRunWithMeta(runId: string, body: ApplyRequest): Promise<ResponseWithMeta<ExecutionResult>> {
  return requestWithMeta<ExecutionResult>(`/v1/runs/${encodeURIComponent(runId)}/apply`, {
    method: 'POST',
    json: body,
    headers: { 'Idempotency-Key': body.idempotency_key },
  });
}

export async function applyRun(runId: string, body: ApplyRequest): Promise<ExecutionResult> {
  const { data } = await applyRunWithMeta(runId, body);
  return data;
}

export function getBrief(runId: string, signal?: AbortSignal): Promise<ReleaseBrief> {
  return request<ReleaseBrief>(`/v1/runs/${encodeURIComponent(runId)}/brief`, { signal });
}

export function getLedger(runId: string, signal?: AbortSignal): Promise<AICallRecord[]> {
  return request<AICallRecord[]>(`/v1/runs/${encodeURIComponent(runId)}/ai-ledger`, { signal });
}

/** Absolute download URL for a run artifact, or null when no API base is available. */
export function artifactUrl(runId: string, name: ArtifactName): string | null {
  const base = resolveApiBase();
  if (!base) return null;
  return `${base}/v1/runs/${encodeURIComponent(runId)}/artifacts/${name}`;
}

export function deleteRun(runId: string): Promise<void> {
  return request<void>(`/v1/runs/${encodeURIComponent(runId)}`, { method: 'DELETE' });
}

/** New run from the stored source + contract of an existing run (determinism proof). */
export function replayRun(runId: string): Promise<ReplayCreated> {
  return request<ReplayCreated>(`/v1/runs/${encodeURIComponent(runId)}/replay`, { method: 'POST' });
}

/** Bulk cleanup for booth resets; `olderThanMinutes = 0` deletes every run. */
export function cleanupRuns(olderThanMinutes: number): Promise<CleanupResult> {
  const query = new URLSearchParams({ older_than_minutes: String(olderThanMinutes) });
  return request<CleanupResult>(`/v1/runs?${query}`, { method: 'DELETE' });
}

/** AI permission card: what the running backend actually does, read from code (§5.6). */
export function getAiContract(signal?: AbortSignal): Promise<AiContract> {
  return request<AiContract>('/v1/ai/contract', { signal });
}

/** Red-team harness for a SEM finding (§5.6). Only `LIVE_INJECTION` calls the model. */
export function redteam(runId: string, findingId: string, redteamCase: RedteamCase): Promise<RedteamResult> {
  return request<RedteamResult>(
    `/v1/runs/${encodeURIComponent(runId)}/findings/${encodeURIComponent(findingId)}/redteam`,
    { method: 'POST', json: { case: redteamCase } },
  );
}

/** Live re-run of the semantic assessment for one SEM finding (§5.2b). 409 when the run is APPLIED. */
export function rerunSemantic(runId: string, findingId: string): Promise<SemanticRerunResult> {
  return request<SemanticRerunResult>(
    `/v1/runs/${encodeURIComponent(runId)}/findings/${encodeURIComponent(findingId)}/semantic`,
    { method: 'POST' },
  );
}

export function listArtifacts(runId: string, signal?: AbortSignal): Promise<ArtifactInfo[]> {
  return request<ArtifactInfo[]>(`/v1/runs/${encodeURIComponent(runId)}/artifacts`, { signal });
}

/** Recompute every hash in the run directory and re-run the validations in memory (§4). */
export function verifyRun(runId: string, signal?: AbortSignal): Promise<VerifyReport> {
  return request<VerifyReport>(`/v1/runs/${encodeURIComponent(runId)}/verify`, { signal });
}

/** In-memory tamper demo: `execute` against a copy with one byte flipped. Nothing is written. */
export function tamperTest(runId: string): Promise<TamperTestResult> {
  return request<TamperTestResult>(`/v1/runs/${encodeURIComponent(runId)}/tamper-test`, { method: 'POST' });
}

/** Generate a client-side idempotency key for `applyRun`. */
export function newIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `idem-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// ---------------------------------------------------------------------------
// Event stream
// ---------------------------------------------------------------------------

export type EventSubscriptionHandlers = {
  onEvent: (event: RunEvent) => void;
  onError?: (error: ApiError) => void;
  onOpen?: (transport: 'sse' | 'polling') => void;
  /** Called with each polled RunDetail while in polling mode, so callers can refresh state. */
  onPoll?: (detail: RunDetail) => void;
};

export type EventSubscriptionOptions = {
  after?: number;
  pollIntervalMs?: number;
};

function isRunEvent(value: unknown): value is RunEvent {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<RunEvent>;
  return typeof candidate.seq === 'number' && typeof candidate.stage === 'string';
}

const TERMINAL_LIFECYCLES = new Set(['REVIEW_REQUIRED', 'OBSERVATIONAL', 'DRY_RUN_READY', 'APPLIED', 'FAILED']);

/**
 * Subscribe to `GET /v1/runs/{id}/events` via EventSource. The stream replays persisted events
 * (after `after`) then tails. If EventSource errors twice, the subscription falls back to polling
 * `getRun` every 2 s and stops once the run reaches a terminal lifecycle. Returns an unsubscribe.
 */
export function subscribeEvents(
  runId: string,
  handlers: EventSubscriptionHandlers,
  options: EventSubscriptionOptions = {},
): () => void {
  const base = resolveApiBase();
  if (!base) {
    handlers.onError?.(noApiError());
    return () => undefined;
  }

  let closed = false;
  let lastSeq = options.after ?? 0;
  let source: EventSource | null = null;
  let errorCount = 0;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  const pollInterval = options.pollIntervalMs ?? 2000;

  const emit = (event: RunEvent) => {
    if (event.seq <= lastSeq) return;
    lastSeq = event.seq;
    handlers.onEvent(event);
  };

  const eventsPath = () => `/v1/runs/${encodeURIComponent(runId)}/events?after=${lastSeq}`;
  const logSse = (note: string, error: ApiError | null = null) =>
    recordApiLog({
      kind: 'sse',
      method: 'SSE',
      path: eventsPath(),
      status: null,
      serverMs: null,
      clientMs: null,
      correlationId: null,
      idempotentReplay: false,
      requestBody: null,
      responseBody: null,
      error: error ? error.toLogError() : null,
      note,
    });

  const closeSource = () => {
    if (source) {
      source.close();
      source = null;
    }
  };

  const startPolling = () => {
    if (closed) return;
    logSse(`polling getRun every ${pollInterval} ms`);
    handlers.onOpen?.('polling');
    const tick = async () => {
      if (closed) return;
      try {
        const detail = await getRun(runId);
        // Unsubscribed while the request was in flight: drop the result silently.
        if (closed) return;
        handlers.onPoll?.(detail);
        if (TERMINAL_LIFECYCLES.has(detail.lifecycle) && detail.lifecycle !== 'FAILED') {
          // Terminal state reached; one final poll is enough.
          return;
        }
        if (detail.lifecycle === 'FAILED') return;
      } catch (reason) {
        if (closed) return;
        if (reason instanceof ApiError) {
          handlers.onError?.(reason);
          // A run that does not exist (or was deleted) will not appear by polling again.
          if (reason.status === 404 || reason.status === 410) return;
        }
      }
      if (!closed) pollTimer = setTimeout(() => void tick(), pollInterval);
    };
    void tick();
  };

  const openSource = () => {
    if (closed || typeof EventSource === 'undefined') {
      startPolling();
      return;
    }
    const url = `${base}${eventsPath()}`;
    const es = new EventSource(url);
    source = es;
    es.onopen = () => {
      errorCount = 0;
      logSse('open');
      handlers.onOpen?.('sse');
    };
    es.onmessage = (message: MessageEvent<string>) => {
      if (!message.data) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(message.data);
      } catch {
        return;
      }
      if (isRunEvent(parsed)) emit(parsed);
    };
    es.onerror = () => {
      errorCount += 1;
      if (errorCount >= 2) {
        closeSource();
        const error = new ApiError({
          code: 'SSE_UNAVAILABLE',
          message_zh: '事件流连接中断，已切换为每 2 秒轮询。',
          message_en: 'Event stream interrupted; switched to polling every 2 s.',
          retryable: true,
          status: 0,
        });
        logSse('error ×2 → closed', error);
        handlers.onError?.(error);
        startPolling();
      } else {
        logSse('error → browser reconnect');
      }
      // On the first error EventSource reconnects on its own with the same `after`.
    };
  };

  openSource();

  return () => {
    closed = true;
    if (source) logSse('unsubscribed');
    closeSource();
    if (pollTimer) clearTimeout(pollTimer);
  };
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

export type HealthState = {
  health: HealthInfo | null;
  error: ApiError | null;
  loading: boolean;
  checkedAt: number | null;
  refresh: () => void;
};

/** Polls `/health` every `intervalMs` (default 15 s). Never throws; errors are surfaced in state. */
export function useHealth(intervalMs = 15_000): HealthState {
  const available = useLiveApiAvailable();
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const [tick, setTick] = useState(0);
  const inflight = useRef<AbortController | null>(null);
  const unavailable = useMemo(() => noApiError(), []);

  useEffect(() => {
    if (!available) return;
    let cancelled = false;
    const run = async () => {
      inflight.current?.abort();
      const controller = new AbortController();
      inflight.current = controller;
      try {
        const info = await getHealth(controller.signal);
        if (cancelled) return;
        setHealth(info);
        setError(null);
      } catch (reason) {
        if (cancelled || (reason instanceof DOMException && reason.name === 'AbortError')) return;
        setHealth(null);
        setError(reason instanceof ApiError ? reason : networkError(reason));
      } finally {
        if (!cancelled) {
          setLoading(false);
          setCheckedAt(Date.now());
        }
      }
    };
    void run();
    const timer = setInterval(() => void run(), intervalMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
      inflight.current?.abort();
    };
  }, [available, intervalMs, tick]);

  const refresh = () => setTick((n) => n + 1);
  if (!available) {
    return { health: null, error: unavailable, loading: false, checkedAt: null, refresh };
  }
  return { health, error, loading, checkedAt, refresh };
}
