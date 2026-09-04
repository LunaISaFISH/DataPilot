'use client';

import { EventLog } from '@/components/datapilot';
import { useLanguage } from '@/lib/language';

import { RUNNING_LIFECYCLES, useWorkspace } from '../workspace-context';

export type EventLogPanelProps = {
  /** `rail`: compact column in the left rail. `prominent`: tall panel in the center while running. */
  mode: 'rail' | 'prominent';
};

/** The real event stream (SSE, polling fallback). No client-side progress is synthesised. */
export function EventLogPanel({ mode }: EventLogPanelProps) {
  const { t, language } = useLanguage();
  const { run, events, transport, streamError } = useWorkspace();
  const live = run ? RUNNING_LIFECYCLES.has(run.lifecycle) : false;
  return (
    <div className={mode === 'rail' ? 'flex flex-col gap-1 px-2 py-2' : 'flex flex-col gap-1'}>
      <EventLog
        events={events}
        mode="expanded"
        maxHeight={mode === 'rail' ? 360 : 300}
        transport={transport}
        live={live}
        emptyText={
          transport === null
            ? t('Connecting to the event stream', '正在连接事件流')
            : transport === 'polling'
              ? t('Polling mode: events are not replayed; state refreshes every 2 s', '轮询模式：不回放事件，每 2 秒刷新状态')
              : t('Waiting for events', '等待事件')
        }
      />
      {streamError && transport === 'polling' ? (
        <p className="px-1 text-[11px] leading-4 text-muted-foreground">
          <span className="mono">{streamError.code}</span> · {streamError.localized(language)}
        </p>
      ) : null}
    </div>
  );
}
