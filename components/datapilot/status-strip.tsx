'use client';

import { ServerCog } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  clearApiBaseOverride,
  normalizeApiBase,
  resolveApiBase,
  setApiBaseOverride,
  useHealth,
} from '@/lib/api';
import { formatInt } from '@/lib/format';
import { useLanguage } from '@/lib/language';
import { cn } from '@/lib/utils';

export type StatusStripProps = {
  className?: string;
  /** Poll interval for /health in ms. */
  intervalMs?: number;
};

function Dot({ tone }: { tone: 'policy' | 'blocker' | 'neutral' | 'review' }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'size-1.5 rounded-full',
        tone === 'policy' && 'bg-policy',
        tone === 'blocker' && 'bg-blocker',
        tone === 'review' && 'bg-review',
        tone === 'neutral' && 'bg-muted-foreground',
      )}
    />
  );
}

function Item({ children, className, title }: { children: React.ReactNode; className?: string; title?: string }) {
  return (
    <span className={cn('inline-flex h-full items-center gap-1.5 whitespace-nowrap px-2.5 text-xs', className)} title={title}>
      {children}
    </span>
  );
}

/** Compact operational strip, only mounted on live-analysis routes. */
export function StatusStrip({ className, intervalMs }: StatusStripProps) {
  const { t, language } = useLanguage();
  const { health, error, loading, apiBase, apiBaseSource } = useHealth(intervalMs);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [draft, setDraft] = useState(apiBase ?? '');
  const [validationError, setValidationError] = useState(false);
  const [savedMessage, setSavedMessage] = useState(false);

  const sourceLabel =
    apiBaseSource === 'query'
      ? t('URL parameter', 'URL 参数')
      : apiBaseSource === 'storage'
        ? t('Saved override', '已保存覆盖')
        : apiBaseSource === 'environment'
          ? t('Environment', '环境变量')
          : t('Local default', '本地默认');

  const saveApiBase = () => {
    setSavedMessage(false);
    const normalized = normalizeApiBase(draft);
    if (!normalized || !setApiBaseOverride(normalized)) {
      setValidationError(true);
      return;
    }
    setDraft(normalized);
    setValidationError(false);
    setSavedMessage(true);
  };

  const clearOverride = () => {
    clearApiBaseOverride();
    setDraft(resolveApiBase());
    setValidationError(false);
    setSavedMessage(true);
  };

  const connected = health !== null;
  const noBase = error?.code === 'NO_API_BASE';
  const apiTone = connected ? 'policy' : loading ? 'review' : 'blocker';
  const apiText = connected
    ? t('API connected', 'API 已连接')
    : loading
      ? t('API checking', 'API 检测中')
      : noBase
        ? t('Replay only', '仅离线回放')
        : t('API unreachable', 'API 未连接');
  const aiLive = Boolean(health && health.ai.available && health.ai.provider === 'anthropic');

  return (
    <div
      className={cn(
        'flex h-(--shell-status-height) items-stretch justify-between border-b border-border bg-[#f7f9f7]',
        className,
      )}
      aria-label={t('Engine status', '引擎状态')}
    >
      <div className="data-dense flex min-w-0 items-stretch divide-x divide-border overflow-x-auto">
        <Item title={error && !noBase ? error.localized(language) : undefined}>
          <Dot tone={apiTone} />
          <span className={cn(!connected && 'text-muted-foreground')}>{apiText}</span>
        </Item>
        {health ? (
          <>
            <Item className="hidden sm:inline-flex">
              <span className="text-muted-foreground">{t('Engine', '引擎')}</span>
              <span className="mono">{health.engine_version}</span>
            </Item>
            <Item className="hidden md:inline-flex">
              {aiLive ? (
                <>
                  <span className="pill pill-ai">AI</span>
                  <span className="mono">{health.ai.model}</span>
                  <span className="hidden text-muted-foreground md:inline">{t('ready', '已就绪')}</span>
                </>
              ) : (
                <>
                  <span className="pill pill-neutral">{t('Deterministic', '确定性')}</span>
                  <span className="text-muted-foreground">{t('fallback', '回退')}</span>
                </>
              )}
            </Item>
            <Item className="hidden md:inline-flex">
              <span className="text-muted-foreground">{t('Samples', '样例')}</span>
              <span className="mono">{formatInt(health.samples)}</span>
            </Item>
          </>
        ) : null}
      </div>
      <div className="flex items-center px-2">
        <Popover
          open={settingsOpen}
          onOpenChange={(open) => {
            setSettingsOpen(open);
            if (open) {
              setDraft(apiBase ?? '');
              setValidationError(false);
              setSavedMessage(false);
            }
          }}
        >
          <PopoverTrigger
            className="inline-flex size-8 items-center justify-center rounded-md text-xs font-medium transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:h-7 sm:w-auto sm:max-w-64 sm:justify-start sm:gap-1.5 sm:border sm:border-border sm:bg-card sm:px-2"
            aria-label={t('Configure backend API', '配置后端 API')}
            title={apiBase ?? undefined}
          >
            <ServerCog aria-hidden="true" className="size-3.5 shrink-0" />
            <span className="hidden shrink-0 sm:inline">{t('Backend', '后端')}</span>
            <span className="mono hidden min-w-0 truncate text-[10px] text-muted-foreground lg:inline">{apiBase}</span>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-[min(22rem,calc(100vw-1rem))] gap-3 p-3">
            <PopoverHeader>
              <PopoverTitle>{t('Backend API', '后端 API')}</PopoverTitle>
              <PopoverDescription>
                {t(
                  'Switch the live API for this browser. Health reconnects immediately.',
                  '切换此浏览器使用的实时 API，健康检查会立即重连。',
                )}
              </PopoverDescription>
            </PopoverHeader>

            <div className="rounded-md border border-border bg-muted/30 p-2">
              <div className="flex items-center justify-between gap-3 text-[11px] text-muted-foreground">
                <span>{t('Current address', '当前地址')}</span>
                <span>{sourceLabel}</span>
              </div>
              <code className="mt-1 block break-all text-xs text-foreground">{apiBase}</code>
            </div>

            <form
              className="space-y-2"
              onSubmit={(event) => {
                event.preventDefault();
                saveApiBase();
              }}
            >
              <label className="block text-xs font-medium" htmlFor="datapilot-api-base">
                {t('API base URL', 'API 基础地址')}
              </label>
              <Input
                id="datapilot-api-base"
                value={draft}
                onChange={(event) => {
                  setDraft(event.target.value);
                  setValidationError(false);
                  setSavedMessage(false);
                }}
                inputMode="url"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                placeholder="http://localhost:8000"
                aria-invalid={validationError || undefined}
                aria-describedby="datapilot-api-help"
                className="mono h-9 text-sm"
              />
              <p
                id="datapilot-api-help"
                className={cn('text-[11px] leading-4 text-muted-foreground', validationError && 'text-blocker')}
                role={validationError ? 'alert' : undefined}
              >
                {validationError
                  ? t(
                      'Enter a full HTTP(S) URL without credentials, query, or fragment.',
                      '请输入不含凭据、查询参数或片段的完整 HTTP(S) 地址。',
                    )
                  : savedMessage
                    ? t('Saved. Reconnecting health check…', '已保存，正在重连健康检查…')
                    : t('Stored only in this browser; credentials are rejected.', '仅保存在此浏览器；不接受含凭据的地址。')}
              </p>
              <div className="flex items-center justify-end gap-2 pt-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="min-h-9 sm:min-h-7"
                  onClick={clearOverride}
                  disabled={apiBaseSource !== 'query' && apiBaseSource !== 'storage'}
                >
                  {t('Clear override', '清除覆盖')}
                </Button>
                <Button type="submit" size="sm" className="min-h-9 sm:min-h-7">
                  {t('Save & reconnect', '保存并重连')}
                </Button>
              </div>
            </form>
          </PopoverContent>
        </Popover>
      </div>
    </div>
  );
}
