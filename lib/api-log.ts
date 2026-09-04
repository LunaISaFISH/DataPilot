'use client';

import { useSyncExternalStore } from 'react';

// In-memory log of every request the client made (spec §9.3). The console's bottom drawer
// subscribes to it. Nothing here is persisted; the store is capped at MAX_ENTRIES.

export const API_LOG_MAX_ENTRIES = 200;
/** Request/response bodies are kept up to this many characters of serialized JSON. */
export const API_LOG_BODY_LIMIT = 64 * 1024;

export type ApiLogKind = 'http' | 'sse';

export type ApiLogError = {
  code: string;
  message_zh: string;
  message_en: string;
  retryable: boolean;
  correlation_id: string | null;
  observed?: unknown;
  expected?: unknown;
};

export type ApiLogEntry = {
  id: number;
  /** Epoch milliseconds when the request completed (or the SSE event happened). */
  time: number;
  kind: ApiLogKind;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'SSE';
  path: string;
  /** HTTP status; 0 for network failures; null for SSE lifecycle rows. */
  status: number | null;
  /** `Server-Timing: total;dur=<ms>` from the response, when exposed. */
  serverMs: number | null;
  /** Wall-clock duration measured in the browser. */
  clientMs: number | null;
  correlationId: string | null;
  /** `X-Idempotent-Replay: true` was present. */
  idempotentReplay: boolean;
  /** Serialized JSON (truncated); never file bytes. */
  requestBody: string | null;
  responseBody: string | null;
  error: ApiLogError | null;
  /** Short free-text note for SSE rows (open / error / polling). */
  note: string | null;
};

export type ApiLogInput = Omit<ApiLogEntry, 'id' | 'time'> & { time?: number };

type Listener = () => void;

const EMPTY: readonly ApiLogEntry[] = Object.freeze([]);
let entries: readonly ApiLogEntry[] = EMPTY;
let nextId = 1;
const listeners = new Set<Listener>();

function notify() {
  for (const listener of listeners) listener();
}

/** Serialize a body for the log, truncating at API_LOG_BODY_LIMIT characters. */
export function serializeBody(value: unknown): string | null {
  if (value === undefined) return null;
  let text: string;
  if (typeof value === 'string') {
    text = value;
  } else {
    try {
      text = JSON.stringify(value, null, 2) ?? `<${typeof value}>`;
    } catch {
      text = `<unserializable ${typeof value}>`;
    }
  }
  if (text.length <= API_LOG_BODY_LIMIT) return text;
  return `${text.slice(0, API_LOG_BODY_LIMIT)}\n… (truncated, ${text.length.toLocaleString('en-US')} chars total)`;
}

/** Append one entry. Returns the assigned id. */
export function recordApiLog(input: ApiLogInput): number {
  const id = nextId;
  nextId += 1;
  const entry: ApiLogEntry = { ...input, id, time: input.time ?? Date.now() };
  const next = entries.length >= API_LOG_MAX_ENTRIES ? entries.slice(entries.length - API_LOG_MAX_ENTRIES + 1) : entries;
  entries = [...next, entry];
  notify();
  return id;
}

export function clearApiLog(): void {
  entries = EMPTY;
  notify();
}

export function getApiLog(): readonly ApiLogEntry[] {
  return entries;
}

export function subscribeApiLog(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getServerSnapshot(): readonly ApiLogEntry[] {
  return EMPTY;
}

/** Live view of the API log for `useSyncExternalStore` consumers (newest last). */
export function useApiLog(): readonly ApiLogEntry[] {
  return useSyncExternalStore(subscribeApiLog, getApiLog, getServerSnapshot);
}
