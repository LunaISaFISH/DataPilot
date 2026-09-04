'use client';

import { Lock } from 'lucide-react';

import { EmptyState, InlineAlert, Pill } from '@/components/datapilot';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { formatInt } from '@/lib/format';
import { pick, useLanguage } from '@/lib/language';
import { label } from '@/lib/labels';
import { cn } from '@/lib/utils';

import { RUNNING_LIFECYCLES, TAB_IDS, useWorkspace, type TabId } from '../workspace-context';
import { ArtifactsTab } from './artifacts-tab';
import { ChangesetTab } from './changeset-tab';
import { ContractTab } from './contract-tab';
import { DecisionsTab } from './decisions-tab';
import { EventLogPanel } from './event-log-panel';
import { FindingsTab } from './findings-tab';
import { ProfileTab } from './profile-tab';
import { ReleaseTab } from './release-tab';

const TAB_LABEL: Record<TabId, readonly [zh: string, en: string]> = {
  profile: ['画像', 'Profile'],
  contract: ['契约', 'Contract'],
  findings: ['发现', 'Findings'],
  decisions: ['处置', 'Decisions'],
  changeset: ['变更集', 'Change set'],
  release: ['验证与发布', 'Validate and release'],
  artifacts: ['工件', 'Artifacts'],
};

const TAB_COMPONENT: Record<TabId, () => React.JSX.Element | null> = {
  profile: ProfileTab,
  contract: ContractTab,
  findings: FindingsTab,
  decisions: DecisionsTab,
  changeset: ChangesetTab,
  release: ReleaseTab,
  artifacts: ArtifactsTab,
};

function tabCount(id: TabId, run: ReturnType<typeof useWorkspace>['run']): string | null {
  if (!run) return null;
  switch (id) {
    case 'findings':
      return run.report ? formatInt(run.report.findings.length) : null;
    case 'decisions': {
      const n = Object.keys(run.decisions).length;
      return n ? formatInt(n) : null;
    }
    case 'changeset':
      return run.dry_run ? formatInt(run.dry_run.actions.length) : null;
    case 'release':
      return run.execution ? formatInt(run.execution.validations.length) : null;
    default:
      return null;
  }
}

/** Tab container only: lock states, the running/failed banners, and mounting of the pane files. */
export function WorkspaceTabs() {
  const { t, language } = useLanguage();
  const { run, activeTab, setActiveTab, tabs, events } = useWorkspace();
  const running = run ? RUNNING_LIFECYCLES.has(run.lifecycle) : false;
  const lastEvent = events[events.length - 1] ?? null;
  const failedEvent = [...events].reverse().find((event) => event.status === 'FAILED') ?? null;

  return (
    <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as TabId)} className="gap-0">
      <div className="sticky top-0 z-10 overflow-x-auto border-b border-black/7 bg-white px-3 sm:px-5">
        <TabsList variant="line" className="h-auto min-h-11 gap-0 sm:h-9 sm:min-h-0" aria-label={t('Console tabs', '控制台页签')}>
          {TAB_IDS.map((id) => {
            const availability = tabs[id];
            const count = tabCount(id, run);
            return (
              <TabsTrigger
                key={id}
                value={id}
                disabled={availability.locked}
                title={availability.locked && availability.reason ? availability.reason : undefined}
                className={cn('flex-none px-2.5 text-[13px]', availability.locked && 'text-muted-foreground')}
              >
                {availability.locked ? <Lock aria-hidden="true" className="size-3" /> : null}
                {pick(language, TAB_LABEL[id][0], TAB_LABEL[id][1])}
                {count ? <span className="mono text-[11px] text-muted-foreground">{count}</span> : null}
              </TabsTrigger>
            );
          })}
        </TabsList>
      </div>

      <div className="flex flex-col gap-4 p-4 sm:p-5">
        {run && running ? (
          <section className="panel flex flex-col gap-2 p-3" aria-live="polite">
            <div className="flex flex-wrap items-center gap-2 text-[13px]">
              <Pill variant="info" dot>
                {label('lifecycle', run.lifecycle, language)}
              </Pill>
              {lastEvent ? (
                <span>
                  <span className="text-muted-foreground">[{label('event_stage', lastEvent.stage, language)}]</span>{' '}
                  {pick(language, lastEvent.message_zh, lastEvent.message_en)}
                </span>
              ) : (
                <span className="text-muted-foreground">{t('Waiting for the first stage event', '等待第一个阶段事件')}</span>
              )}
            </div>
            <EventLogPanel mode="prominent" />
          </section>
        ) : null}

        {run && run.lifecycle === 'FAILED' ? (
          <InlineAlert
            variant="error"
            title={
              <span className="inline-flex items-center gap-2">
                <span className="mono">FAILED</span>
                {failedEvent ? <span className="font-normal">[{label('event_stage', failedEvent.stage, language)}]</span> : null}
              </span>
            }
          >
            <div>{run.error ?? (failedEvent ? pick(language, failedEvent.message_zh, failedEvent.message_en) : t('The pipeline failed.', '流水线执行失败。'))}</div>
            {failedEvent && typeof failedEvent.detail.correlation_id === 'string' ? (
              <div className="mt-1 text-[11px]">
                {t('Correlation id', '关联 ID')} <span className="mono">{failedEvent.detail.correlation_id}</span>
              </div>
            ) : null}
          </InlineAlert>
        ) : null}

        {TAB_IDS.map((id) => {
          const Pane = TAB_COMPONENT[id];
          const availability = tabs[id];
          return (
            <TabsContent key={id} value={id} className="min-w-0">
              {availability.locked ? (
                <EmptyState
                  icon={<Lock />}
                  title={`${pick(language, TAB_LABEL[id][0], TAB_LABEL[id][1])} · ${t('Locked', '未解锁')}`}
                  description={availability.reason ?? undefined}
                />
              ) : (
                <Pane />
              )}
            </TabsContent>
          );
        })}
      </div>
    </Tabs>
  );
}
