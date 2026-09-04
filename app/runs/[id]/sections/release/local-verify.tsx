'use client';

import { useEffect, useRef, useState } from 'react';

import { InlineAlert } from '@/components/datapilot';
import { Button } from '@/components/ui/button';
import { artifactUrl } from '@/lib/api';
import { recordApiLog } from '@/lib/api-log';
import { formatBytes, formatMs } from '@/lib/format';
import { sha256Hex } from '@/lib/hash';
import { useLanguage } from '@/lib/language';
import type { ArtifactName, ReleaseManifest } from '@/lib/types';
import { cn } from '@/lib/utils';

import { FullHash, HashVerdict } from './hash-equality';

// 本地复验 (spec §9.3): download the raw artifact bytes, hash them with crypto.subtle and compare
// with the manifest. Only raw file bytes are hashed in the browser; JSON-derived hashes are the
// server's job (`GET /verify`).

type Target = { name: ArtifactName; zh: string; en: string; expected: (manifest: ReleaseManifest) => string };

const TARGETS: readonly Target[] = [
  { name: 'release.csv', zh: '发布文件', en: 'Release file', expected: (m) => m.release_artifact_hash },
  { name: 'candidate.csv', zh: '候选文件', en: 'Candidate file', expected: (m) => m.candidate_artifact_hash },
  { name: 'changes.jsonl', zh: '变更账本', en: 'Change ledger', expected: (m) => m.change_ledger_hash },
];

type Outcome =
  | { state: 'idle' }
  | { state: 'running'; startedAt: number }
  | { state: 'done'; computed: string; bytes: number; elapsedMs: number; status: number }
  | { state: 'failed'; message: string; status: number | null; elapsedMs: number };

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

async function fetchAndHash(url: string, path: string, signal: AbortSignal): Promise<Outcome> {
  const started = now();
  let response: Response;
  try {
    response = await fetch(url, { signal, cache: 'no-store' });
  } catch (reason) {
    if (reason instanceof DOMException && reason.name === 'AbortError') throw reason;
    const elapsedMs = Math.round(now() - started);
    recordApiLog({ kind: 'http', method: 'GET', path, status: 0, serverMs: null, clientMs: elapsedMs, correlationId: null, idempotentReplay: false, requestBody: null, responseBody: null, error: { code: 'NETWORK_ERROR', message_zh: '无法下载工件。', message_en: 'The artifact could not be downloaded.', retryable: true, correlation_id: null }, note: 'local verify' });
    return { state: 'failed', message: reason instanceof Error ? reason.message : String(reason), status: null, elapsedMs };
  }
  const buffer = await response.arrayBuffer();
  const elapsedMs = Math.round(now() - started);
  const correlationId = response.headers.get('X-Correlation-Id');
  if (!response.ok) {
    recordApiLog({ kind: 'http', method: 'GET', path, status: response.status, serverMs: null, clientMs: elapsedMs, correlationId, idempotentReplay: false, requestBody: null, responseBody: null, error: { code: `HTTP_${response.status}`, message_zh: '工件下载失败。', message_en: 'Artifact download failed.', retryable: response.status >= 500, correlation_id: correlationId }, note: 'local verify' });
    return { state: 'failed', message: `HTTP ${response.status}`, status: response.status, elapsedMs };
  }
  recordApiLog({ kind: 'http', method: 'GET', path, status: response.status, serverMs: null, clientMs: elapsedMs, correlationId, idempotentReplay: false, requestBody: null, responseBody: null, error: null, note: `local verify · ${buffer.byteLength} bytes` });
  try {
    const computed = await sha256Hex(buffer);
    return { state: 'done', computed, bytes: buffer.byteLength, elapsedMs: Math.round(now() - started), status: response.status };
  } catch (reason) {
    return { state: 'failed', message: reason instanceof Error ? reason.message : String(reason), status: response.status, elapsedMs };
  }
}

export type LocalVerifyProps = {
  runId: string;
  manifest: ReleaseManifest;
};

export function LocalVerify({ runId, manifest }: LocalVerifyProps) {
  const { t, language } = useLanguage();
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({});
  const controllers = useRef<Map<string, AbortController>>(new Map());

  useEffect(() => {
    const active = controllers.current;
    return () => {
      for (const controller of active.values()) controller.abort();
      active.clear();
    };
  }, []);

  const run = async (target: Target) => {
    const url = artifactUrl(runId, target.name);
    if (!url) {
      setOutcomes((prev) => ({ ...prev, [target.name]: { state: 'failed', message: t('No API base configured.', '未配置 API 地址。'), status: null, elapsedMs: 0 } }));
      return;
    }
    controllers.current.get(target.name)?.abort();
    const controller = new AbortController();
    controllers.current.set(target.name, controller);
    setOutcomes((prev) => ({ ...prev, [target.name]: { state: 'running', startedAt: Date.now() } }));
    try {
      const outcome = await fetchAndHash(url, `/v1/runs/${runId}/artifacts/${target.name}`, controller.signal);
      if (!controller.signal.aborted) setOutcomes((prev) => ({ ...prev, [target.name]: outcome }));
    } catch (reason) {
      if (reason instanceof DOMException && reason.name === 'AbortError') return;
      throw reason;
    }
  };

  const runAll = () => {
    for (const target of TARGETS) void run(target);
  };
  const anyRunning = TARGETS.some((target) => outcomes[target.name]?.state === 'running');
  const secure = typeof crypto !== 'undefined' && Boolean(crypto.subtle);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          {t(
            'The browser downloads the file, hashes the raw bytes with crypto.subtle and compares with the manifest. Nothing is recomputed from JSON here.',
            '浏览器下载文件，用 crypto.subtle 对原始字节计算 SHA-256，并与清单比对。此处不从 JSON 重算任何哈希。',
          )}
        </p>
        <Button size="sm" onClick={runAll} disabled={anyRunning || !secure}>
          {anyRunning ? t('Hashing', '计算中') : t('Verify all locally', '全部本地复验')}
        </Button>
      </div>
      {!secure ? <InlineAlert variant="warning">{t('crypto.subtle is unavailable (insecure context); local verification cannot run here.', 'crypto.subtle 不可用（非安全上下文），无法在此进行本地复验。')}</InlineAlert> : null}
      <ul className="flex flex-col divide-y divide-border">
        {TARGETS.map((target) => {
          const expected = target.expected(manifest);
          const outcome = outcomes[target.name] ?? { state: 'idle' };
          const computed = outcome.state === 'done' ? outcome.computed : null;
          return (
            <li key={target.name} className="flex flex-col gap-1.5 py-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="flex items-center gap-2 text-xs">
                  <span className="mono">{target.name}</span>
                  <span className="text-muted-foreground">{language === 'zh' ? target.zh : target.en}</span>
                </span>
                <span className="flex items-center gap-2">
                  {outcome.state === 'done' ? (
                    <span className="mono text-[11px] text-muted-foreground">
                      {formatBytes(outcome.bytes)} · {formatMs(outcome.elapsedMs)}
                    </span>
                  ) : null}
                  <HashVerdict left={computed} right={expected} />
                  <Button size="xs" variant="outline" onClick={() => void run(target)} disabled={outcome.state === 'running' || !secure}>
                    {outcome.state === 'running' ? t('Downloading', '下载中') : outcome.state === 'idle' ? t('Verify', '复验') : t('Again', '再次')}
                  </Button>
                </span>
              </div>
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-[11px]">
                <dt className="text-muted-foreground">{t('Manifest', '清单')}</dt>
                <dd>
                  <FullHash value={expected} />
                </dd>
                <dt className="text-muted-foreground">{t('Browser', '浏览器')}</dt>
                <dd className={cn(outcome.state === 'failed' && 'text-blocker')}>
                  {outcome.state === 'done' ? (
                    <FullHash value={outcome.computed} />
                  ) : outcome.state === 'failed' ? (
                    <span className="mono">
                      {t('failed', '失败')} · {outcome.message}
                    </span>
                  ) : outcome.state === 'running' ? (
                    <span className="mono text-muted-foreground">GET {`/v1/runs/${runId}/artifacts/${target.name}`}</span>
                  ) : (
                    <span className="mono text-muted-foreground">—</span>
                  )}
                </dd>
              </dl>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
