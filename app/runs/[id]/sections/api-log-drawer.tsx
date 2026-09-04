'use client';

import { ChevronDown, ChevronUp } from 'lucide-react';
import { Fragment, useState } from 'react';

import { Pill } from '@/components/datapilot';
import { Button } from '@/components/ui/button';
import { clearApiLog, useApiLog, type ApiLogEntry } from '@/lib/api-log';
import { formatInt, formatTime } from '@/lib/format';
import { pick, useLanguage } from '@/lib/language';
import { cn } from '@/lib/utils';

function isFailed(entry: ApiLogEntry): boolean {
  return entry.error !== null || (entry.status !== null && (entry.status === 0 || entry.status >= 400));
}

function ms(value: number | null): string {
  return value === null ? '—' : `${formatInt(Math.round(value))} ms`;
}

function Summary({ entry }: { entry: ApiLogEntry }) {
  return (
    <span className={cn('mono inline-flex min-w-0 items-center gap-2 text-xs', isFailed(entry) && 'text-blocker')}>
      <span suppressHydrationWarning>{formatTime(new Date(entry.time).toISOString())}</span>
      <span className="font-semibold">{entry.method}</span>
      <span className="truncate">{entry.path}</span>
      <span>{entry.status ?? entry.note ?? ''}</span>
      {entry.serverMs !== null ? <span>{ms(entry.serverMs)}</span> : null}
    </span>
  );
}

/**
 * Bottom drawer listing every request the client made (spec §9.2). Collapsed: a 28px bar with
 * the last request. Expanded: table with time, METHOD path, status, server/client ms,
 * correlation id; failed rows red with the structured error body; click a row for bodies.
 */
export function ApiLogDrawer() {
  const { t, language } = useLanguage();
  const entries = useApiLog();
  const [open, setOpen] = useState(false);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const last = entries[entries.length - 1] ?? null;
  const failures = entries.filter(isFailed).length;
  const rows = [...entries].reverse();

  return (
    <section className="hidden shrink-0 border-t border-border bg-card md:block" aria-label={t('API log', 'API 日志')}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex h-7 w-full items-center gap-3 px-3 text-left hover:bg-muted"
      >
        <span className="inline-flex items-center gap-1 text-xs font-semibold">
          {open ? <ChevronDown aria-hidden="true" className="size-3.5" /> : <ChevronUp aria-hidden="true" className="size-3.5" />}
          {t('API log', 'API 日志')}
        </span>
        <span className="mono text-[11px] text-muted-foreground">
          {formatInt(entries.length)}
          {failures ? <span className="text-blocker"> · {formatInt(failures)} {t('failed', '失败')}</span> : null}
        </span>
        <span className="min-w-0 flex-1 overflow-hidden">{last ? <Summary entry={last} /> : <span className="text-xs text-muted-foreground">{t('No requests yet', '尚无请求')}</span>}</span>
      </button>

      {open ? (
        <div className="max-h-72 overflow-auto border-t border-border">
          <div className="flex items-center justify-between px-3 py-1 text-[11px] text-muted-foreground">
            <span>
              {t('Server duration from Server-Timing; correlation id from X-Correlation-Id; bodies truncated at 64 KiB, file bytes never logged.', '服务端耗时来自 Server-Timing；关联 ID 来自 X-Correlation-Id；请求体截断于 64 KiB，从不记录文件字节。')}
            </span>
            <Button size="xs" variant="ghost" onClick={() => clearApiLog()} disabled={entries.length === 0}>
              {t('Clear', '清空')}
            </Button>
          </div>
          <table className="dp-table">
            <thead>
              <tr>
                <th>{t('Time', '时间')}</th>
                <th>{t('Method', '方法')}</th>
                <th>{t('Path', '路径')}</th>
                <th data-align="right">{t('Status', '状态')}</th>
                <th data-align="right">{t('Server', '服务端')}</th>
                <th data-align="right">{t('Client', '客户端')}</th>
                <th>{t('Correlation id', '关联 ID')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-6! text-center text-muted-foreground">
                    {t('No requests yet', '尚无请求')}
                  </td>
                </tr>
              ) : (
                rows.map((entry) => {
                  const failed = isFailed(entry);
                  const expanded = expandedId === entry.id;
                  return (
                    <Fragment key={entry.id}>
                      <tr
                        data-clickable="true"
                        data-selected={expanded ? 'true' : undefined}
                        className={cn(failed && 'text-blocker')}
                        onClick={() => setExpandedId(expanded ? null : entry.id)}
                      >
                        <td className="mono text-xs" suppressHydrationWarning>
                          {formatTime(new Date(entry.time).toISOString())}
                        </td>
                        <td className="mono text-xs font-semibold">{entry.method}</td>
                        <td className="mono max-w-[40ch] truncate text-xs" title={entry.path}>
                          {entry.path}
                          {entry.note ? <span className="text-muted-foreground"> · {entry.note}</span> : null}
                          {entry.idempotentReplay ? (
                            <Pill variant="info" className="ml-2 align-middle">
                              X-Idempotent-Replay
                            </Pill>
                          ) : null}
                        </td>
                        <td className="cell-num">{entry.status ?? '—'}</td>
                        <td className="cell-num">{ms(entry.serverMs)}</td>
                        <td className="cell-num">{ms(entry.clientMs)}</td>
                        <td className="mono text-xs">{entry.correlationId ?? '—'}</td>
                      </tr>
                      {expanded ? (
                        <tr>
                          <td colSpan={7} className="bg-muted!">
                            <div className="grid gap-2 py-1 lg:grid-cols-2">
                              {entry.error ? (
                                <div className="lg:col-span-2">
                                  <div className="text-[11px] font-semibold text-blocker">
                                    {entry.error.code} · {pick(language, entry.error.message_zh, entry.error.message_en)}
                                  </div>
                                  <pre className="mono max-h-40 overflow-auto rounded-md border border-blocker/30 bg-card px-2 py-1 text-[11px] leading-4 whitespace-pre-wrap break-all text-foreground">
                                    {JSON.stringify(entry.error, null, 2)}
                                  </pre>
                                </div>
                              ) : null}
                              <div>
                                <div className="text-[11px] font-semibold text-muted-foreground">{t('Request', '请求')}</div>
                                <pre className="mono max-h-56 overflow-auto rounded-md border border-border bg-card px-2 py-1 text-[11px] leading-4 whitespace-pre-wrap break-all text-foreground">
                                  {entry.requestBody ?? '—'}
                                </pre>
                              </div>
                              <div>
                                <div className="text-[11px] font-semibold text-muted-foreground">{t('Response', '响应')}</div>
                                <pre className="mono max-h-56 overflow-auto rounded-md border border-border bg-card px-2 py-1 text-[11px] leading-4 whitespace-pre-wrap break-all text-foreground">
                                  {entry.responseBody ?? '—'}
                                </pre>
                              </div>
                            </div>
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}
