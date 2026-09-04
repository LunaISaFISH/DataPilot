'use client';

import type { ReactNode } from 'react';

import { HashChip } from '@/components/datapilot/hash-chip';
import { InlineAlert } from '@/components/datapilot/inline-alert';
import { Pill } from '@/components/datapilot/pill';
import { Button } from '@/components/ui/button';
import type { ApiError } from '@/lib/api';
import { useLanguage } from '@/lib/language';

/** Hex digest of ≥ 16 characters (sha256 prefixes, full hashes). */
export function isHashLike(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{16,}$/i.test(value);
}

/** Render an observed/expected value: HashChip for digests, mono text otherwise. */
export function ObservedValue({ value }: { value: unknown }) {
  if (value === undefined || value === null) return <span className="mono text-muted-foreground">—</span>;
  if (isHashLike(value)) return <HashChip value={value} length={16} />;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return <span className="mono break-all">{String(value)}</span>;
  }
  return <span className="mono break-all">{JSON.stringify(value)}</span>;
}

export type GuardRowProps = {
  error: ApiError;
  /** Optional context, typically the request that failed (`GET /v1/runs`). */
  title?: ReactNode;
  onRetry?: () => void;
  retryLabel?: string;
  /** Extra actions rendered next to retry. */
  actions?: ReactNode;
  className?: string;
};

/**
 * Designed guard row for refused requests (409/422/5xx/network): structured code, localized
 * message, correlation id, and observed vs expected side by side when the server sent them.
 * Used by every page; never a toast.
 */
export function GuardRow({ error, title, onRetry, retryLabel, actions, className }: GuardRowProps) {
  const { t, language } = useLanguage();
  const hasComparison = error.observed !== undefined || error.expected !== undefined;
  return (
    <InlineAlert
      variant={error.status >= 400 && error.status < 500 && error.status !== 409 && error.status !== 422 ? 'warning' : 'error'}
      className={className}
      title={
        <span className="inline-flex flex-wrap items-center gap-2">
          <Pill variant="blocker" className="mono font-semibold">
            {error.status ? `${error.status} · ${error.code}` : error.code}
          </Pill>
          {title ? <span className="mono text-xs">{title}</span> : null}
        </span>
      }
      actions={
        onRetry || actions ? (
          <>
            {actions}
            {onRetry ? (
              <Button size="sm" variant="outline" onClick={onRetry}>
                {retryLabel ?? t('Retry', '重试')}
              </Button>
            ) : null}
          </>
        ) : undefined
      }
    >
      <div>{error.localized(language)}</div>
      {hasComparison ? (
        <dl className="mt-1.5 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs text-foreground">
          <dt className="text-muted-foreground">{t('Observed', '观测')}</dt>
          <dd>
            <ObservedValue value={error.observed} />
          </dd>
          <dt className="text-muted-foreground">{t('Expected', '期望')}</dt>
          <dd>
            <ObservedValue value={error.expected} />
          </dd>
        </dl>
      ) : null}
      <div className="mt-1 flex flex-wrap items-center gap-x-3 text-[11px] text-muted-foreground">
        {error.correlation_id ? (
          <span>
            {t('Correlation id', '关联 ID')} <span className="mono">{error.correlation_id}</span>
          </span>
        ) : null}
        {error.retryable ? <span>{t('Retryable', '可重试')}</span> : null}
      </div>
    </InlineAlert>
  );
}
