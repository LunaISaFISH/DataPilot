'use client';

import { Check } from 'lucide-react';

import { formatInt, formatTime } from '@/lib/format';
import { useLanguage } from '@/lib/language';
import type { AICallRecord, ArtifactInfo, RunDetail, RunEvent } from '@/lib/types';
import { cn } from '@/lib/utils';

import { useWorkspace } from '../workspace-context';

type RailState = {
  id: string;
  zh: string;
  en: string;
  done: boolean;
  /** Artifact file the state is read from. */
  file: string;
  /** ISO timestamp the state comes from (artifact mtime or stage completion), if known. */
  at: string | null;
  /** Short status line (counts, or why the state does not apply). */
  detail: string | null;
  notApplicable?: boolean;
};

function eventTime(events: RunEvent[], stage: string, status: 'COMPLETED' | 'FAILED' = 'COMPLETED'): string | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event && event.stage === stage && event.status === status) return event.ts;
  }
  return null;
}

function artifactTime(artifacts: ArtifactInfo[], name: string): string | null {
  return artifacts.find((artifact) => artifact.name === name)?.modified_at ?? null;
}

/** Derive the eight lifecycle states from real run state (spec §9.2). Exported for tests/other panes. */
export function deriveRailStates(
  run: RunDetail,
  events: RunEvent[],
  artifacts: ArtifactInfo[],
  ledger: AICallRecord[],
  t: (en: string, zh: string) => string,
): RailState[] {
  const report = run.report;
  const at = (file: string, stage: string | null, fallback: string | null = null) =>
    artifactTime(artifacts, file) ?? (stage ? eventTime(events, stage) : null) ?? fallback;
  const semanticRecords = ledger.filter((record) => record.task === 'semantic');
  const semanticDone = Boolean(report) && (eventTime(events, 'SEMANTIC_ANALYSIS') !== null || semanticRecords.length > 0);
  const observational = report ? report.contract.source === 'baseline' : run.contract === null;
  const decisionCount = Object.keys(run.decisions).length;
  const validations = run.execution?.validations ?? [];
  const failed = validations.filter((validation) => !validation.passed).length;

  return [
    {
      id: 'ingested',
      zh: '已接收',
      en: 'Ingested',
      done: true,
      file: 'source.csv',
      at: at('source.csv', 'INGESTING', run.created_at),
      detail: report ? `${formatInt(report.profile.record_count)} ${t('records', '条记录')}` : null,
    },
    {
      id: 'profiled',
      zh: '已画像',
      en: 'Profiled',
      done: report !== null,
      file: 'report.json',
      at: report ? at('report.json', 'PROFILING') : null,
      detail: report ? `${formatInt(report.profile.column_count)} ${t('columns', '个字段')}` : null,
    },
    {
      id: 'detected',
      zh: '已检测',
      en: 'Detected',
      done: report !== null,
      file: 'report.json',
      at: report ? at('report.json', 'DETECTING') : null,
      detail: report ? `${formatInt(report.findings.length)} ${t('findings', '个问题')}` : null,
    },
    {
      id: 'semantic',
      zh: '语义已评估',
      en: 'Semantics assessed',
      done: semanticDone,
      file: 'ai-ledger.jsonl',
      at: semanticDone ? at('ai-ledger.jsonl', 'SEMANTIC_ANALYSIS') : null,
      detail:
        report && observational
          ? t('Observational: no semantic scope', '仅观测：无语义范围')
          : semanticRecords.length
            ? `${formatInt(semanticRecords.length)} ${t('ledger calls', '次账本调用')}`
            : null,
      notApplicable: Boolean(report) && observational && semanticRecords.length === 0,
    },
    {
      id: 'decided',
      zh: '已处置',
      en: 'Decided',
      done: decisionCount > 0 || run.dry_run !== null,
      file: 'decisions.json',
      at: decisionCount > 0 || run.dry_run ? at('decisions.json', null) : null,
      detail: decisionCount > 0 ? `${formatInt(decisionCount)} ${t('decisions', '项处置')}` : null,
    },
    {
      id: 'dry_run',
      zh: '已预演',
      en: 'Dry run',
      done: run.dry_run !== null,
      file: 'dry-run.json',
      at: run.dry_run ? at('dry-run.json', 'DRY_RUN') : null,
      detail: run.dry_run ? `${formatInt(run.dry_run.actions.length)} ${t('actions', '个动作')}` : null,
    },
    {
      id: 'applied',
      zh: '已执行',
      en: 'Applied',
      done: run.execution !== null,
      file: 'execution.json',
      at: run.execution ? at('execution.json', 'APPLY') : null,
      detail: run.execution ? `${formatInt(run.execution.release_manifest.eligible_record_count)} ${t('eligible', '可发布')}` : null,
    },
    {
      id: 'validated',
      zh: '已验证',
      en: 'Validated',
      done: run.execution !== null,
      file: 'release-manifest.json',
      at: run.execution ? at('release-manifest.json', 'APPLY') : null,
      detail: run.execution
        ? `${formatInt(validations.length - failed)} / ${formatInt(validations.length)} ${t('checks passed', '项检查通过')}`
        : null,
    },
  ];
}

export function LifecycleRail() {
  const { t, language } = useLanguage();
  const { run, events, artifacts, ledger } = useWorkspace();
  if (!run) {
    return (
      <div className="border-b border-border px-3 py-2 text-[11px] text-muted-foreground">
        {t('Lifecycle', '生命周期')} · {t('waiting for run', '等待运行数据')}
      </div>
    );
  }
  const states = deriveRailStates(run, events, artifacts, ledger, t);
  const failed = run.lifecycle === 'FAILED';
  const activeIndex = failed ? -1 : states.findIndex((state) => !state.done && !state.notApplicable);

  return (
    <nav aria-label={t('Lifecycle', '生命周期')} className="border-b border-border px-3 py-2">
      <div className="flex items-center justify-between pb-1 text-[11px] text-muted-foreground">
        <span>{t('Lifecycle', '生命周期')}</span>
        <span className="mono">{formatInt(states.filter((state) => state.done).length)} / 8</span>
      </div>
      <ol className="flex flex-col">
        {states.map((state, index) => {
          const active = index === activeIndex;
          const last = index === states.length - 1;
          return (
            <li key={state.id} className="relative flex gap-2" data-state={state.done ? 'done' : active ? 'active' : 'pending'}>
              <div className="flex flex-col items-center">
                <span
                  className={cn(
                    'mt-0.5 grid size-4 shrink-0 place-items-center rounded-full border',
                    state.done && 'border-policy bg-policy text-primary-foreground',
                    !state.done && active && 'border-policy bg-policy-tint',
                    !state.done && !active && 'border-border bg-muted',
                  )}
                  aria-hidden="true"
                >
                  {state.done ? <Check className="size-2.5" /> : active ? <span className="size-1.5 rounded-full bg-policy" /> : null}
                </span>
                {!last ? <span aria-hidden="true" className={cn('my-0.5 w-px flex-1', state.done ? 'bg-policy' : 'bg-border')} /> : null}
              </div>
              <div className="min-w-0 flex-1 pb-2">
                <div className="flex items-baseline justify-between gap-2">
                  <span className={cn('text-[12.5px] font-semibold leading-4', !state.done && 'text-muted-foreground')}>
                    {language === 'zh' ? state.zh : state.en}
                  </span>
                  <span className="mono text-[10.5px] text-muted-foreground" suppressHydrationWarning>
                    {state.at ? formatTime(state.at) : ''}
                  </span>
                </div>
                <div className="flex items-baseline justify-between gap-2 text-[10.5px] leading-4 text-muted-foreground">
                  <span className="mono truncate">{state.file}</span>
                  {state.detail ? <span className="shrink-0 truncate">{state.detail}</span> : null}
                </div>
              </div>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
