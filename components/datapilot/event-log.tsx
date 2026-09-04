'use client';

import { useEffect, useRef, useState } from 'react';

import { formatMs, formatTime } from '@/lib/format';
import { pick, useLanguage } from '@/lib/language';
import { label } from '@/lib/labels';
import type { RunEvent } from '@/lib/types';
import { cn } from '@/lib/utils';

export type EventLogProps = {
  events: RunEvent[];
  mode?: 'compact' | 'expanded';
  maxHeight?: number;
  autoscroll?: boolean;
  /** Shown while the stream is connected but no event has arrived yet. */
  emptyText?: string;
  /** Optional transport note rendered in the header (e.g. "SSE" or "轮询"). */
  transport?: 'sse' | 'polling' | null;
  live?: boolean;
  className?: string;
};

const MARKER: Record<string, string> = {
  STARTED: '›',
  COMPLETED: '✓',
  FAILED: '✗',
  INFO: 'i',
};

export function EventLog({
  events,
  mode = 'expanded',
  maxHeight,
  autoscroll = true,
  emptyText,
  transport = null,
  live = false,
  className,
}: EventLogProps) {
  const { t, language } = useLanguage();
  const scroller = useRef<HTMLDivElement | null>(null);
  const [pinned, setPinned] = useState(true);
  const height = maxHeight ?? (mode === 'compact' ? 96 : 320);

  useEffect(() => {
    if (!autoscroll || !pinned) return;
    const node = scroller.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [events.length, autoscroll, pinned]);

  return (
    <div className={cn('flex flex-col', className)}>
      <div className="flex items-center justify-between px-1 pb-1 text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          {live ? <span aria-hidden="true" className="size-1.5 animate-pulse rounded-full bg-policy" /> : null}
          {t('Event stream', '事件流')} · {events.length}
        </span>
        <span className="inline-flex items-center gap-2">
          {transport ? <span>{transport === 'sse' ? 'SSE' : t('Polling 2 s', '轮询 2 s')}</span> : null}
          {!pinned ? (
            <button
              type="button"
              className="underline underline-offset-2"
              onClick={() => {
                setPinned(true);
                const node = scroller.current;
                if (node) node.scrollTop = node.scrollHeight;
              }}
            >
              {t('Jump to latest', '跳到最新')}
            </button>
          ) : null}
        </span>
      </div>
      <div
        ref={scroller}
        className="log-panel"
        style={{ height, maxHeight: height }}
        role="log"
        aria-live="polite"
        aria-label={t('Pipeline events', '流水线事件')}
        onScroll={(event) => {
          const node = event.currentTarget;
          const atBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 8;
          if (atBottom !== pinned) setPinned(atBottom);
        }}
      >
        {events.length === 0 ? (
          <div className="px-3 py-2 text-[#8fa39c]">{emptyText ?? t('Waiting for events', '等待事件')}</div>
        ) : (
          events.map((event) => (
            <div key={event.seq} className="log-line" data-status={event.status} title={pick(language, event.message_zh, event.message_en)}>
              <span className="log-ts" suppressHydrationWarning>
                {formatTime(event.ts)}
              </span>
              <span className="log-marker">{MARKER[event.status] ?? '·'}</span>
              <span className="log-msg">
                <span className="text-[#b7c8c2]">[{label('event_stage', event.stage, language)}]</span>{' '}
                {pick(language, event.message_zh, event.message_en)}
              </span>
              <span className="log-elapsed">{event.elapsed_ms !== null ? formatMs(event.elapsed_ms) : ''}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
