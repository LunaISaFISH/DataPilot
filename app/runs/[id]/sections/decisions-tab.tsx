'use client';

import { useMemo, useState } from 'react';

import { DataTable, EmptyState, InlineAlert, PanelSection, Pill, type DataTableColumn } from '@/components/datapilot';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { ApiError } from '@/lib/api';
import { formatInt } from '@/lib/format';
import { pick, useLanguage, type Language } from '@/lib/language';
import { findingPrefixOf, label } from '@/lib/labels';
import type { AICallRecord, DecisionInput, DecisionOutcome, DecisionsResponse, Finding, RunDetail } from '@/lib/types';
import { cn } from '@/lib/utils';

import { useWorkspace } from '../workspace-context';
import { AuthCodeChip, RiskDot, Stat, isSemFinding, ledgerRecordFor } from './finding/helpers';
import { GuardRow } from '@/components/datapilot';

const OUTCOMES: readonly DecisionOutcome[] = ['APPROVE_PROPOSAL', 'QUARANTINE', 'EXCLUDE', 'FLAG_FOR_REVIEW', 'REJECT_PROPOSAL'];

/** Preset reason chips (spec §9.2); stored as plain text joined with '；'. */
const PRESET_REASONS: readonly { zh: string; en: string }[] = [
  { zh: '证据支持受限范围', en: 'Evidence supports the limited scope' },
  { zh: '需人工复核', en: 'Needs manual review' },
  { zh: '敏感字段整列排除', en: 'Exclude the sensitive column entirely' },
  { zh: '业务口径待确认', en: 'Business definition pending confirmation' },
  { zh: '重复导入无需保留', en: 'Duplicate import, nothing to keep' },
];
const SEPARATOR = '；';

type FormEntry = { outcome: DecisionOutcome | null; chips: string[]; note: string };
type FormState = Record<string, FormEntry>;

function composeReason(entry: FormEntry): string | null {
  const parts = [...entry.chips, entry.note.trim()].filter(Boolean);
  return parts.length > 0 ? parts.join(SEPARATOR) : null;
}

function parseReason(reason: string | null): { chips: string[]; note: string } {
  if (!reason) return { chips: [], note: '' };
  const presets = new Set(PRESET_REASONS.map((preset) => preset.zh));
  const chips: string[] = [];
  const notes: string[] = [];
  for (const part of reason.split(SEPARATOR).map((piece) => piece.trim()).filter(Boolean)) {
    if (presets.has(part)) chips.push(part);
    else notes.push(part);
  }
  return { chips, note: notes.join(SEPARATOR) };
}

function formFromRun(run: RunDetail, findings: Finding[]): FormState {
  const state: FormState = {};
  for (const finding of findings) {
    const decision = run.decisions[finding.finding_id];
    state[finding.finding_id] = decision ? { outcome: decision.outcome, ...parseReason(decision.reason) } : { outcome: null, chips: [], note: '' };
  }
  return state;
}

function sameForm(a: FormState, b: FormState): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    const x = a[key];
    const y = b[key];
    if (!x || !y) return false;
    if (x.outcome !== y.outcome || composeReason(x) !== composeReason(y)) return false;
  }
  return true;
}

/** Why an outcome is disabled for a finding, in policy terms. */
function disallowedReason(finding: Finding, outcome: DecisionOutcome, language: Language, record: AICallRecord | null): string {
  const zh = language === 'zh';
  if (finding.authorization_mode === 'QUARANTINE_ONLY' && outcome !== 'QUARANTINE') return zh ? '仅允许隔离' : 'Quarantine only';
  if (finding.authorization_mode === 'FORBIDDEN') return zh ? '策略禁止自动处理' : 'Policy forbids automated handling';
  if (outcome === 'APPROVE_PROPOSAL') {
    if (isSemFinding(finding.finding_id)) {
      const proposal = finding.proposal;
      if (record?.status === 'rejected_by_grounding' || (proposal && !proposal.grounding.valid)) return zh ? 'AI 提议未通过接地校验' : 'AI proposal failed grounding';
      if (!proposal) return zh ? '无 AI 提议' : 'No AI proposal';
      if (proposal.abstained) return zh ? 'AI 已弃权，无可批准的提议' : 'AI abstained; nothing to approve';
    }
    if (finding.proposed_action === null) return zh ? '无可执行提议' : 'No executable proposal';
  }
  if (outcome === 'EXCLUDE' && findingPrefixOf(finding.finding_id) !== 'PHI') return zh ? '仅敏感字段可整列排除' : 'Only sensitive columns can be excluded';
  return zh ? '契约未允许该结果' : 'Not allowed by the contract';
}

function DecisionRow({ finding, entry, disabled, onChange }: {
  finding: Finding;
  entry: FormEntry;
  disabled: boolean;
  onChange: (next: FormEntry) => void;
}) {
  const { t, language } = useLanguage();
  const { setSelectedFindingId, selectedFindingId, ledger } = useWorkspace();
  const record = ledgerRecordFor(finding, ledger);
  const allowed = new Set(finding.allowed_outcomes);
  const selected = selectedFindingId === finding.finding_id;
  const toggleChip = (chip: string) => {
    const has = entry.chips.includes(chip);
    onChange({ ...entry, chips: has ? entry.chips.filter((c) => c !== chip) : [...entry.chips, chip] });
  };
  return (
    <li className={cn('flex flex-col gap-2 border-b border-border px-3 py-2.5 last:border-b-0', selected && 'bg-policy-tint/40', entry.outcome === null && 'border-l-2 border-l-review')}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <button type="button" className="flex flex-wrap items-center gap-2 text-left hover:underline" onClick={() => setSelectedFindingId(finding.finding_id)} title={t('Open in the inspector', '在右侧查看详情')}>
            <span className="mono text-xs font-semibold">{finding.finding_id}</span>
            <span className="text-[13px] leading-5">{pick(language, finding.title_zh, finding.title_en)}</span>
          </button>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            <RiskDot value={finding.risk_level} />
            <AuthCodeChip value={finding.authorization_mode} />
            <span className="text-muted-foreground">{label('authorization_mode', finding.authorization_mode, language)}</span>
            {finding.column ? <Stat k={t('column', '列')} v={<span className="mono">{finding.column}</span>} /> : null}
            <Stat k={t('records', '记录')} v={formatInt(finding.affected_record_count)} />
            {finding.blocking ? <Pill variant="blocker">{t('Blocking', '阻断')}</Pill> : null}
          </div>
        </div>
        <span className={cn('text-[11px] whitespace-nowrap', entry.outcome ? 'text-policy' : 'text-review')}>{entry.outcome ? t('Decided', '已选择') : t('Unresolved', '未处置')}</span>
      </div>

      <fieldset className="inline-flex flex-wrap items-stretch overflow-hidden rounded-md border border-border">
        <legend className="sr-only">{t('Outcome', '处置结果')}</legend>
        {OUTCOMES.map((outcome) => {
          const ok = allowed.has(outcome);
          const active = entry.outcome === outcome;
          const why = ok ? undefined : disallowedReason(finding, outcome, language, record);
          return (
            <button
              key={outcome}
              type="button"
              aria-pressed={active}
              disabled={!ok || disabled}
              title={why ? `${label('decision_outcome', outcome, language)} · ${why}` : label('decision_outcome', outcome, language)}
              onClick={() => onChange({ ...entry, outcome: active ? null : outcome })}
              className={cn(
                'flex min-w-[9ch] flex-col items-start gap-0 border-r border-border px-2 py-1 text-left text-xs last:border-r-0',
                active ? 'bg-foreground text-background' : ok ? 'bg-card hover:bg-muted' : 'cursor-not-allowed bg-muted text-muted-foreground',
              )}
            >
              <span className={cn(!ok && 'line-through decoration-muted-foreground/60')}>{label('decision_outcome', outcome, language)}</span>
              <span className={cn('mono text-[10px]', active ? 'text-background/70' : 'text-muted-foreground')}>{ok ? outcome : why}</span>
            </button>
          );
        })}
      </fieldset>

      <div className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-1">
          <span className="text-[11px] text-muted-foreground">{t('Reason', '理由')}</span>
          {PRESET_REASONS.map((preset) => {
            const active = entry.chips.includes(preset.zh);
            return (
              <button
                key={preset.zh}
                type="button"
                disabled={disabled}
                aria-pressed={active}
                onClick={() => toggleChip(preset.zh)}
                className={cn(
                  'inline-flex h-6 items-center rounded-md border px-2 text-xs transition-colors',
                  active ? 'border-policy bg-policy-tint text-policy' : 'border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground',
                )}
                title={preset.en}
              >
                {preset.zh}
              </button>
            );
          })}
        </div>
        <Textarea
          value={entry.note}
          disabled={disabled}
          onChange={(event) => onChange({ ...entry, note: event.target.value })}
          placeholder={t('Free-text reason (optional)', '补充说明（可选）')}
          className="min-h-8 text-xs md:text-xs"
          rows={1}
          aria-label={t('Free-text reason', '补充说明')}
        />
      </div>
    </li>
  );
}

/**
 * 处置 tab (spec §9.2): one decision row per non-policy finding with outcomes limited to
 * `allowed_outcomes`, preset reason chips plus free text, read-only policy rows with their
 * authorization_ref, unresolved counter, 保存处置 → PUT /decisions, 生成变更集 → POST /dry-run.
 */
export function DecisionsTab() {
  const { t, language } = useLanguage();
  const { run, putDecisions, createDryRun, busy, setActiveTab } = useWorkspace();
  const [edits, setEdits] = useState<FormState>({});
  const [saveError, setSaveError] = useState<ApiError | null>(null);
  const [dryRunError, setDryRunError] = useState<ApiError | null>(null);
  const [saved, setSaved] = useState<DecisionsResponse | null>(null);

  const findings = useMemo(() => run?.report?.findings ?? [], [run]);
  const human = useMemo(() => findings.filter((finding) => finding.authorization_mode !== 'POLICY_AUTHORIZED'), [findings]);
  const policy = useMemo(() => findings.filter((finding) => finding.authorization_mode === 'POLICY_AUTHORIZED'), [findings]);
  const serverForm = useMemo(() => (run ? formFromRun(run, human) : {}), [run, human]);
  // Saved decisions prefill the form; local edits overlay them until 保存处置 succeeds.
  const form = useMemo<FormState>(() => ({ ...serverForm, ...edits }), [serverForm, edits]);
  const dirty = Object.keys(edits).length > 0;

  if (!run?.report) return <EmptyState title={t('No report yet', '尚无报告')} />;

  const applied = run.lifecycle === 'APPLIED';
  const readOnly = applied || busy.putDecisions || busy.createDryRun;
  const unresolvedLocal = human.filter((finding) => !form[finding.finding_id]?.outcome);
  const decidedLocal = human.length - unresolvedLocal.length;
  const unresolvedServer = saved?.unresolved ?? null;
  const unresolvedShown = unresolvedServer ?? unresolvedLocal.map((finding) => finding.finding_id);
  const changed = !sameForm(form, serverForm);
  const dryRun = run.dry_run;
  const staleDryRun = dryRun !== null && dryRun.run_revision !== run.run_revision;
  const decisionsSaved = Object.keys(run.decisions).length > 0;
  const contract = run.report.contract;

  const update = (findingId: string, entry: FormEntry) => {
    setEdits((previous) => ({ ...previous, [findingId]: entry }));
    setSaved(null);
  };

  const save = async () => {
    setSaveError(null);
    setDryRunError(null);
    const decisions: DecisionInput[] = human
      .map((finding) => ({ finding, entry: form[finding.finding_id] }))
      .filter((pair): pair is { finding: Finding; entry: FormEntry & { outcome: DecisionOutcome } } => Boolean(pair.entry?.outcome))
      .map(({ finding, entry }) => ({ finding_id: finding.finding_id, outcome: entry.outcome, reason: composeReason(entry) }));
    try {
      const response = await putDecisions(decisions);
      setSaved(response);
      setEdits({});
    } catch (reason) {
      if (reason instanceof ApiError) setSaveError(reason);
    }
  };

  const generate = async () => {
    setDryRunError(null);
    try {
      await createDryRun();
      setActiveTab('changeset');
    } catch (reason) {
      if (reason instanceof ApiError) setDryRunError(reason);
    }
  };

  const titleOf = (findingId: string) => {
    const finding = findings.find((entry) => entry.finding_id === findingId);
    return finding ? pick(language, finding.title_zh, finding.title_en) : findingId;
  };

  const policyColumns: DataTableColumn<Finding>[] = [
    { key: 'finding_id', header: 'ID', render: (row) => <span className="mono text-xs">{row.finding_id}</span> },
    { key: 'title', header: t('Title', '标题'), render: (row) => <span className="line-clamp-2 max-w-[40ch] text-xs leading-4">{pick(language, row.title_zh, row.title_en)}</span> },
    { key: 'risk', header: t('Risk', '风险'), render: (row) => <RiskDot value={row.risk_level} className="text-xs" /> },
    { key: 'action', header: t('Action', '动作'), render: (row) => (row.proposed_action ? <span className="mono text-xs">{row.proposed_action}</span> : <span className="text-muted-foreground">—</span>) },
    { key: 'records', header: t('Records', '记录'), align: 'right', render: (row) => formatInt(row.affected_record_count) },
    {
      key: 'authorization_ref',
      header: 'authorization_ref',
      render: (row) => {
        const action = dryRun?.actions.find((entry) => entry.finding_id === row.finding_id);
        const preview = `${contract.id}@${contract.version}:${row.finding_id}`;
        return (
          <span className="inline-flex flex-wrap items-center gap-1.5">
            <span className="mono text-[11px] break-all">{action?.authorization_ref ?? preview}</span>
            <span className="text-[10px] text-muted-foreground">{action ? t('from change set', '来自变更集') : t('preview', '预览')}</span>
          </span>
        );
      },
    },
  ];

  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-card px-3 py-1.5">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <Stat k={t('need a decision', '需处置')} v={formatInt(human.length)} />
          <Stat k={t('decided', '已选择')} v={formatInt(decidedLocal)} tone="policy" />
          <Stat k={t('unresolved', '未处置')} v={formatInt(unresolvedLocal.length)} tone={unresolvedLocal.length ? 'review' : 'muted'} />
          <Stat k={t('policy authorized', '策略授权')} v={formatInt(policy.length)} tone="muted" />
          {changed ? <Pill variant="review">{t('Unsaved changes', '有未保存修改')}</Pill> : null}
          {applied ? <Pill variant="neutral">{t('Applied · read-only', '已执行 · 只读')}</Pill> : null}
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" disabled={readOnly || decidedLocal === 0 || (!changed && !dirty)} onClick={() => void save()}>
            {busy.putDecisions ? t('Saving', '保存中') : t('Save decisions', '保存处置')}
          </Button>
          <Button size="sm" disabled={readOnly || changed || (!decisionsSaved && human.length > 0)} onClick={() => void generate()} title={changed ? t('Save decisions first', '请先保存处置') : undefined}>
            {busy.createDryRun ? t('Generating', '生成中') : t('Generate change set', '生成变更集')}
          </Button>
        </div>
      </div>

      {busy.putDecisions ? <p className="mono text-[11px] text-muted-foreground">PUT /v1/runs/{run.run_id}/decisions …</p> : null}
      {busy.createDryRun ? <p className="mono text-[11px] text-muted-foreground">POST /v1/runs/{run.run_id}/dry-run …</p> : null}

      {saveError ? <GuardRow error={saveError} title={t('Decisions refused', '处置未被接受')} onRetry={() => void save()} /> : null}
      {dryRunError ? (
        <GuardRow error={dryRunError} title={t('Change set refused', '变更集未生成')} onRetry={() => void generate()} />
      ) : null}
      {unresolvedShown.length > 0 && (dryRunError || saved) ? (
        <InlineAlert variant="warning" title={`${unresolvedServer ? t('Saved · the server still reports unresolved findings', '已保存 · 服务端仍报告未处置的问题') : t('Unresolved findings', '未处置的问题')} · ${formatInt(unresolvedShown.length)}`}>
          <ul className="flex flex-col gap-0.5">
            {unresolvedShown.map((findingId) => (
              <li key={findingId}>
                <span className="mono">{findingId}</span> · {titleOf(findingId)}
              </li>
            ))}
          </ul>
        </InlineAlert>
      ) : null}

      {saved && unresolvedShown.length === 0 ? (
        <InlineAlert variant="info" title={t('Saved · every human decision is in place', '已保存 · 所有人工处置已就位')}>
          {formatInt(Object.keys(saved.decisions).length)} {t('decisions stored for revision', '条处置已存储，对应修订')} r{run.run_revision}
          {t('; decision_set_hash is computed by the server when the change set is generated.', '；decision_set_hash 在生成变更集时由服务端计算。')}
        </InlineAlert>
      ) : null}

      {staleDryRun ? (
        <InlineAlert variant="warning" title={t('Change set invalidated', '变更集已失效')}>
          {t('It was built for revision', '它基于修订')} r{dryRun.run_revision}; {t('the run is now at', '运行现为')} r{run.run_revision}. {t('Generate it again.', '请重新生成。')}
        </InlineAlert>
      ) : decisionsSaved && dryRun === null && !changed ? (
        <InlineAlert variant="info" title={t('No current change set', '当前没有变更集')}>
          {t('Decisions are saved but no dry run exists for them (a change to decisions or a re-assessment invalidates the previous one). Generate the change set to continue.', '处置已保存，但尚无对应的预演（处置变更或重新评估会使旧变更集失效）。生成变更集以继续。')}
        </InlineAlert>
      ) : dryRun !== null && changed ? (
        <InlineAlert variant="warning" title={t('Change set will be invalidated', '变更集将失效')}>
          {t('Saving these edits changes decision_set_hash; the existing change set must be regenerated.', '保存这些修改会改变 decision_set_hash，现有变更集需要重新生成。')}
        </InlineAlert>
      ) : null}

      <PanelSection
        id="decisions-human"
        title={t('Human decisions', '人工处置')}
        description={t('Outcomes are limited to allowed_outcomes; disabled ones show the policy reason.', '结果仅限 allowed_outcomes；不可选项显示策略原因。')}
        flush
      >
        {human.length === 0 ? (
          <p className="p-3 text-xs text-muted-foreground">{t('Every finding is policy-authorized; nothing needs a human decision.', '所有问题均由策略授权，无需人工处置。')}</p>
        ) : (
          <ul className="flex flex-col">
            {human.map((finding) => (
              <DecisionRow
                key={finding.finding_id}
                finding={finding}
                entry={form[finding.finding_id] ?? { outcome: null, chips: [], note: '' }}
                disabled={readOnly}
                onChange={(entry) => update(finding.finding_id, entry)}
              />
            ))}
          </ul>
        )}
      </PanelSection>

      <PanelSection
        id="decisions-policy"
        title={t('Policy authorized', '策略授权')}
        description={t('Executed automatically under the contract; authorization_ref = <contract id>@<version>:<finding id>.', '契约下自动执行；authorization_ref = <契约 id>@<版本>:<问题 id>。')}
        flush
      >
        <DataTable columns={policyColumns} rows={policy} rowKey={(row) => row.finding_id} maxHeight={320} emptyTitle={t('No policy-authorized findings', '没有策略授权的问题')} ariaLabel={t('Policy authorized findings', '策略授权的问题')} />
      </PanelSection>
    </div>
  );
}
