'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';

import { HashChip, InlineAlert } from '@/components/datapilot';
import {
  ApiError,
  applyRunWithMeta,
  createDryRun as apiCreateDryRun,
  draftContract as apiDraftContract,
  getLedger,
  getRun,
  listArtifacts,
  putContract as apiPutContract,
  putDecisions as apiPutDecisions,
  redteam as apiRedteam,
  replayRun as apiReplayRun,
  rerunSemantic as apiRerunSemantic,
  subscribeEvents,
  tamperTest as apiTamperTest,
  useHealth,
  verifyRun as apiVerifyRun,
} from '@/lib/api';
import { useLanguage } from '@/lib/language';
import type { AICallRecord, ApplyRequest, ArtifactInfo, RunDetail, RunEvent } from '@/lib/types';
import { cn } from '@/lib/utils';

import { AiSupervisionRail } from './sections/ai-supervision-rail';
import { ApiLogDrawer } from './sections/api-log-drawer';
import { EventLogPanel } from './sections/event-log-panel';
import { FindingInspector } from './sections/finding-inspector';
import { GuardRow } from '@/components/datapilot';
import { HeaderStrip } from './sections/header-strip';
import { LifecycleRail } from './sections/lifecycle-rail';
import { WorkspaceTabs } from './sections/tabs';
import {
  RUNNING_LIFECYCLES,
  WorkspaceContext,
  type MutationKey,
  type StreamTransport,
  type TabAvailability,
  type TabId,
  type WorkspaceContextValue,
} from './workspace-context';

const IDLE: Record<MutationKey, boolean> = {
  refresh: false,
  putContract: false,
  draftContract: false,
  putDecisions: false,
  createDryRun: false,
  applyRun: false,
  rerunSemantic: false,
  redteam: false,
  tamperTest: false,
  verifyRun: false,
  replayRun: false,
};

function mergeEvents(previous: RunEvent[], incoming: RunEvent): RunEvent[] {
  if (previous.some((event) => event.seq === incoming.seq)) return previous;
  const last = previous[previous.length - 1];
  if (!last || last.seq < incoming.seq) return [...previous, incoming];
  return [...previous, incoming].sort((a, b) => a.seq - b.seq);
}

type MutationDeps = {
  setBusy: Dispatch<SetStateAction<Record<MutationKey, boolean>>>;
  setLastError: Dispatch<SetStateAction<ApiError | null>>;
  setStreamGeneration: Dispatch<SetStateAction<number>>;
  refresh: () => Promise<void>;
};

/**
 * Wraps a mutation: busy flag for its duration, `lastError` bookkeeping, optional re-subscribe
 * of the event stream, and a RunDetail refresh afterwards (also after a refusal — a 409 means the
 * server state moved under us). The ApiError is re-thrown so the pane renders its guard row.
 */
function createMutationRunner(deps: MutationDeps) {
  return async function runMutation<T>(key: MutationKey, call: () => Promise<T>, options: { restream?: boolean } = {}): Promise<T> {
    deps.setBusy((previous) => ({ ...previous, [key]: true }));
    try {
      const result = await call();
      deps.setLastError(null);
      if (options.restream) deps.setStreamGeneration((generation) => generation + 1);
      return result;
    } catch (reason) {
      if (reason instanceof ApiError) deps.setLastError(reason);
      throw reason;
    } finally {
      deps.setBusy((previous) => ({ ...previous, [key]: false }));
      void deps.refresh();
    }
  };
}

export type RunWorkspaceProps = {
  runId: string;
};

/**
 * The run console: loads RunDetail, tails the event stream (SSE with polling fallback),
 * refreshes after stage completions and after every mutation, and exposes everything to the
 * panes through WorkspaceContext. Layout per spec §9.2: header strip, 240px lifecycle rail with
 * the live log, center tabs, 400px context pane, bottom API log drawer.
 */
export function RunWorkspace({ runId }: RunWorkspaceProps) {
  const { t, language } = useLanguage();
  const health = useHealth(30_000);
  const [run, setRun] = useState<RunDetail | null>(null);
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [transport, setTransport] = useState<StreamTransport>(null);
  const [streamError, setStreamError] = useState<ApiError | null>(null);
  const [ledger, setLedger] = useState<AICallRecord[]>([]);
  const [artifacts, setArtifacts] = useState<ArtifactInfo[]>([]);
  const [selectedFindingId, setSelectedFindingId] = useState<string | null>(null);
  const [tabOverride, setTabOverride] = useState<TabId | null>(null);
  const [busy, setBusy] = useState<Record<MutationKey, boolean>>(IDLE);
  const [lastError, setLastError] = useState<ApiError | null>(null);
  const [streamGeneration, setStreamGeneration] = useState(0);
  const lastSeqRef = useRef(0);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    setBusy((previous) => ({ ...previous, refresh: true }));
    try {
      const detail = await getRun(runId);
      setRun(detail);
      setLoadError(null);
      const [ledgerResult, artifactsResult] = await Promise.allSettled([getLedger(runId), listArtifacts(runId)]);
      if (ledgerResult.status === 'fulfilled') setLedger(Array.isArray(ledgerResult.value) ? ledgerResult.value : []);
      if (artifactsResult.status === 'fulfilled') {
        setArtifacts(Array.isArray(artifactsResult.value) ? artifactsResult.value : []);
      }
    } catch (reason) {
      if (reason instanceof ApiError) setLoadError(reason);
    } finally {
      setBusy((previous) => ({ ...previous, refresh: false }));
    }
  }, [runId]);

  /** Coalesce bursts of stage completions into one RunDetail reload. */
  const scheduleRefresh = useCallback(() => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = null;
      void refresh();
    }, 150);
  }, [refresh]);

  useEffect(() => {
    scheduleRefresh();
    return () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    };
  }, [scheduleRefresh]);

  useEffect(() => {
    const unsubscribe = subscribeEvents(
      runId,
      {
        onEvent: (event) => {
          if (event.seq > lastSeqRef.current) lastSeqRef.current = event.seq;
          setEvents((previous) => mergeEvents(previous, event));
          if (event.status === 'COMPLETED' || event.status === 'FAILED') scheduleRefresh();
        },
        onError: (error) => setStreamError(error),
        onOpen: (mode) => {
          setTransport(mode);
          if (mode === 'sse') setStreamError(null);
        },
        onPoll: (detail) => setRun(detail),
      },
      { after: lastSeqRef.current },
    );
    return unsubscribe;
  }, [health.apiBase, runId, streamGeneration, scheduleRefresh]);

  const runMutation = useMemo(() => createMutationRunner({ setBusy, setLastError, setStreamGeneration, refresh }), [refresh]);

  const tabs = useMemo<Record<TabId, TabAvailability>>(() => {
    const open: TabAvailability = { locked: false, reason: null };
    if (!run) {
      const reason = t('Loading run', '正在加载运行');
      return {
        profile: { locked: true, reason },
        contract: { locked: true, reason },
        findings: { locked: true, reason },
        decisions: { locked: true, reason },
        changeset: { locked: true, reason },
        release: { locked: true, reason },
        artifacts: { locked: true, reason },
      };
    }
    const running = RUNNING_LIFECYCLES.has(run.lifecycle);
    const noReport: TabAvailability = {
      locked: true,
      reason: running
        ? t('Analysis in progress; the report is not written yet', '分析进行中，报告尚未生成')
        : t('No report for this run', '本次运行没有报告'),
    };
    const hasReport = run.report !== null;
    const decisions: TabAvailability = !hasReport
      ? noReport
      : run.lifecycle === 'OBSERVATIONAL'
        ? { locked: true, reason: t('Quick scan: add release rules before choosing how to handle issues', '快速扫描只展示问题；设置发布规则后才能选择处理方式') }
        : running
          ? noReport
          : open;
    const changeset: TabAvailability =
      run.dry_run !== null
        ? open
        : { locked: true, reason: t('No execution preview yet; generate it from Decisions', '请先在“处理”中确认问题并生成执行预览') };
    const release: TabAvailability =
      run.execution !== null || run.dry_run !== null
        ? open
        : { locked: true, reason: t('Requires an execution preview first', '请先生成执行预览') };
    return {
      profile: hasReport ? open : noReport,
      contract: running ? { locked: true, reason: t('Analysis in progress', '分析进行中') } : open,
      findings: hasReport && !running ? open : noReport,
      decisions,
      changeset,
      release,
      artifacts: open,
    };
  }, [run, t]);

  const defaultTab: TabId = run?.report ? 'findings' : 'profile';
  const activeTab = tabOverride ?? defaultTab;

  const selectedFinding = useMemo(
    () => run?.report?.findings.find((finding) => finding.finding_id === selectedFindingId) ?? null,
    [run, selectedFindingId],
  );

  const value = useMemo<WorkspaceContextValue>(
    () => ({
      runId,
      run,
      loadError,
      events,
      transport,
      streamError,
      ledger,
      artifacts,
      health,
      language,
      selectedFindingId,
      selectedFinding,
      setSelectedFindingId,
      activeTab,
      setActiveTab: setTabOverride,
      tabs,
      refresh,
      busy,
      lastError,
      putContract: (yaml) => runMutation('putContract', () => apiPutContract(runId, yaml), { restream: true }),
      draftContract: () => runMutation('draftContract', () => apiDraftContract(runId), { restream: true }),
      putDecisions: (decisions) => runMutation('putDecisions', () => apiPutDecisions(runId, decisions)),
      createDryRun: () => runMutation('createDryRun', () => apiCreateDryRun(runId)),
      applyRun: (body: ApplyRequest) =>
        runMutation(
          'applyRun',
          async () => {
            const { data, meta } = await applyRunWithMeta(runId, body);
            return { result: data, meta };
          },
          { restream: true },
        ),
      rerunSemantic: (findingId) => runMutation('rerunSemantic', () => apiRerunSemantic(runId, findingId)),
      redteam: (findingId, redteamCase) => runMutation('redteam', () => apiRedteam(runId, findingId, redteamCase)),
      tamperTest: () => runMutation('tamperTest', () => apiTamperTest(runId)),
      verifyRun: () => runMutation('verifyRun', () => apiVerifyRun(runId)),
      replayRun: () => runMutation('replayRun', () => apiReplayRun(runId)),
    }),
    [
      runId,
      run,
      loadError,
      events,
      transport,
      streamError,
      ledger,
      artifacts,
      health,
      language,
      selectedFindingId,
      selectedFinding,
      activeTab,
      tabs,
      refresh,
      busy,
      lastError,
      runMutation,
    ],
  );

  return (
    <WorkspaceContext.Provider value={value}>
      <div className="data-dense flex h-[calc(100dvh-var(--shell-header-height)-var(--shell-status-height))] min-h-0 flex-col bg-[linear-gradient(180deg,#f7f8f5_0%,#eef3f1_72%)]">
        <HeaderStrip />
        {loadError && !run ? (
          <div className="px-3 pb-3 sm:px-5">
            <GuardRow
              error={loadError}
              title={
                <span>
                  {t('Run could not be loaded', '无法加载运行')} <HashChip value={runId} length={12} />
                </span>
              }
              onRetry={() => void refresh()}
            />
          </div>
        ) : null}
        {!run && !loadError ? (
          <div className="px-3 pb-3 sm:px-5">
            <InlineAlert variant="info" title={t('Loading run', '正在加载运行')}>
              {t('Preparing the latest results…', '正在准备最新结果…')}
            </InlineAlert>
          </div>
        ) : null}
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 px-3 pb-3 sm:px-5 sm:pb-5 xl:grid-cols-[220px_minmax(0,1fr)_360px]">
          <aside className="hidden min-h-0 flex-col overflow-y-auto rounded-2xl border border-black/8 bg-white shadow-[0_12px_36px_rgba(16,35,30,0.04)] xl:flex">
            <LifecycleRail />
            <EventLogPanel mode="rail" />
          </aside>
          <section className="min-h-0 min-w-0 overflow-y-auto rounded-2xl border border-black/8 bg-white shadow-[0_12px_36px_rgba(16,35,30,0.04)]">
            <WorkspaceTabs />
          </section>
          {selectedFindingId ? (
            <button
              type="button"
              aria-label={t('Close issue details', '关闭问题详情')}
              className="fixed inset-x-0 bottom-0 top-[calc(var(--shell-header-height)+var(--shell-status-height))] z-40 bg-foreground/20 backdrop-blur-[1px] xl:hidden"
              onClick={() => setSelectedFindingId(null)}
            />
          ) : null}
          <aside
            className={cn(
              'min-h-0 overflow-y-auto rounded-2xl border border-black/8 bg-white',
              selectedFindingId
                ? 'fixed inset-x-3 bottom-3 top-[calc(var(--shell-header-height)+var(--shell-status-height)+0.75rem)] z-50 block shadow-2xl xl:static xl:z-auto xl:shadow-[0_12px_36px_rgba(16,35,30,0.04)]'
                : 'hidden shadow-[0_12px_36px_rgba(16,35,30,0.04)] xl:block',
            )}
          >
            {selectedFindingId ? <FindingInspector findingId={selectedFindingId} /> : <AiSupervisionRail />}
          </aside>
        </div>
        <ApiLogDrawer />
      </div>
    </WorkspaceContext.Provider>
  );
}
