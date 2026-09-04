'use client';

import { useEffect, useState } from 'react';

import { InlineAlert } from '@/components/datapilot';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { formatDateTime, formatInt } from '@/lib/format';
import { pick, useLanguage } from '@/lib/language';

import { ReplayChangesetTab } from './replay-changeset-tab';
import { loadReplayBundle, REPLAY_FILES, type ReplayBundle } from './replay-data';
import { ReplayFindingsTab } from './replay-findings-tab';
import { ReplayHeader } from './replay-header';
import { ReplayOverviewTab } from './replay-overview-tab';
import { ReplayReleaseTab } from './replay-release-tab';

type TabId = 'overview' | 'findings' | 'changeset' | 'release';

const TAB_IDS: readonly TabId[] = ['overview', 'findings', 'changeset', 'release'];

const TAB_LABEL: Record<TabId, readonly [zh: string, en: string]> = {
  overview: ['概览', 'Overview'],
  findings: ['发现', 'Findings'],
  changeset: ['变更集', 'Change set'],
  release: ['验证与发布', 'Validate and release'],
};

function tabCount(id: TabId, bundle: ReplayBundle | null): string | null {
  if (!bundle) return null;
  switch (id) {
    case 'findings':
      return bundle.report ? formatInt(bundle.report.findings.length) : null;
    case 'changeset':
      return bundle.execution?.dry_run ? formatInt(bundle.execution.dry_run.actions.length) : null;
    case 'release':
      return bundle.execution ? formatInt(bundle.execution.validations.length) : null;
    default:
      return null;
  }
}

type LoadState = { status: 'loading' } | { status: 'ready'; bundle: ReplayBundle };

/**
 * Offline replay of the recorded clinical_nlp run. Read-only: the static files under /demo are
 * fetched once, normalised, and rendered with the console's shared components. No timers, no
 * simulated progress, no model or API calls.
 */
export function DemoExperience() {
  const { t, language } = useLanguage();
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [activeTab, setActiveTab] = useState<TabId>('overview');

  useEffect(() => {
    let cancelled = false;
    void loadReplayBundle().then((bundle) => {
      if (!cancelled) setState({ status: 'ready', bundle });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const bundle = state.status === 'ready' ? state.bundle : null;
  const failedFiles = bundle ? bundle.files.filter((file) => file.status !== 'ok') : [];

  return (
    <div className="data-dense flex min-h-full flex-col bg-background">
      <ReplayHeader bundle={bundle} />

      {state.status === 'loading' ? (
        <div className="p-3">
          <InlineAlert variant="info" title={t('Reading static artifacts', '正在读取静态工件')}>
            <span className="mono">{REPLAY_FILES.map((file) => `GET ${file.path}`).join(' · ')}</span>
          </InlineAlert>
        </div>
      ) : null}

      {bundle && failedFiles.length > 0 ? (
        <div className="p-3 pb-0">
          <InlineAlert variant={bundle.report ? 'warning' : 'error'} title={t('Some replay files could not be read', '部分回放文件无法读取')}>
            <ul className="mono text-xs">
              {failedFiles.map((file) => (
                <li key={file.name}>
                  GET {file.path} → {file.http_status ?? t('network error', '网络错误')} · {file.status}
                </li>
              ))}
            </ul>
            <p className="mt-1 text-xs">{t('Sections that depend on a missing file render 不可用.', '依赖缺失文件的部分显示为不可用。')}</p>
          </InlineAlert>
        </div>
      ) : null}

      {bundle ? (
        <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as TabId)} className="gap-0">
          <div className="sticky top-(--shell-strip-height) z-10 flex items-center justify-between border-b border-border bg-background px-3">
            <TabsList variant="line" className="h-9 gap-0" aria-label={t('Replay tabs', '回放页签')}>
              {TAB_IDS.map((id) => {
                const count = tabCount(id, bundle);
                return (
                  <TabsTrigger key={id} value={id} className="flex-none px-2.5 text-[13px]">
                    {pick(language, TAB_LABEL[id][0], TAB_LABEL[id][1])}
                    {count ? <span className="mono text-[11px] text-muted-foreground">{count}</span> : null}
                  </TabsTrigger>
                );
              })}
            </TabsList>
            <span className="hidden text-[11px] text-muted-foreground md:inline" suppressHydrationWarning>
              {t('Files read at', '文件读取于')} {formatDateTime(bundle.loaded_at, language)}
            </span>
          </div>
          <div className="p-3">
            <TabsContent value="overview" className="min-w-0">
              <ReplayOverviewTab bundle={bundle} />
            </TabsContent>
            <TabsContent value="findings" className="min-w-0">
              <ReplayFindingsTab bundle={bundle} />
            </TabsContent>
            <TabsContent value="changeset" className="min-w-0">
              <ReplayChangesetTab bundle={bundle} />
            </TabsContent>
            <TabsContent value="release" className="min-w-0">
              <ReplayReleaseTab bundle={bundle} />
            </TabsContent>
          </div>
        </Tabs>
      ) : null}
    </div>
  );
}
