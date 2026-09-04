'use client';

import { LanguageToggle } from '@/components/language-toggle';
import { useHealth } from '@/lib/api';
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

/** Top status strip: API connectivity, engine version, AI provider/model, sample count, language. */
export function StatusStrip({ className, intervalMs }: StatusStripProps) {
  const { t, language } = useLanguage();
  const { health, error, loading } = useHealth(intervalMs);

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
        'flex h-(--shell-strip-height) items-stretch justify-between border-b border-border bg-card',
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
            <Item>
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
      <div className="flex items-center gap-2 px-2">
        <LanguageToggle />
      </div>
    </div>
  );
}
