'use client';

import {
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  Database,
  ExternalLink,
  FileCheck2,
  Fingerprint,
  LockKeyhole,
  RotateCcw,
  ShieldCheck,
  UserCheck,
} from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';

import { HashChip } from '@/components/datapilot';
import { buttonVariants } from '@/components/ui/button';
import { boothDemo, boothFinding } from '@/lib/booth-demo';
import { formatInt } from '@/lib/format';
import { pick, useLanguage } from '@/lib/language';
import { cn } from '@/lib/utils';

const STEPS = [
  { id: 'facts', en: 'Find issues', zh: '发现问题' },
  { id: 'proposal', en: 'Review AI', zh: '审核 AI' },
  { id: 'govern', en: 'Make decisions', zh: '做出决定' },
  { id: 'release', en: 'Share safely', zh: '安全交付' },
] as const;

function Score({ value, small = false }: { value: number; small?: boolean }) {
  return (
    <span className={cn('mono font-semibold tracking-[-0.055em] text-ink', small ? 'text-2xl' : 'text-5xl sm:text-6xl')}>
      {value.toFixed(2)}
    </span>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="text-xs font-medium text-policy">{children}</div>;
}

function DataPoint({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div>
      <div className="mono text-xl font-semibold tracking-[-0.04em] text-ink">{value}</div>
      <div className="mt-1 text-xs font-medium text-foreground">{label}</div>
      {note ? <div className="mt-0.5 text-[11px] leading-4 text-muted-foreground">{note}</div> : null}
    </div>
  );
}

type Translate = (en: string, zh: string) => string;

function signalLabel(signal: string, t: Translate): string {
  const labels: Record<string, [string, string]> = {
    canonical_glossary_match: ['In the approved vocabulary', '目标在批准词表中'],
    normalized_string_match: ['Text similarity checked', '已检查文本相似性'],
    code_cooccurrence_consistency: ['Related fields checked', '已检查相关字段'],
    grounding_validation: ['Evidence references verified', '证据引用已核验'],
  };
  const label = labels[signal];
  return label ? t(label[0], label[1]) : signal;
}

function signalNote(signal: string, fallbackEn: string, fallbackZh: string, t: Translate): string {
  const notes: Record<string, [string, string]> = {
    canonical_glossary_match: ['“Ireland” is an allowed value in this dataset.', '这份数据明确允许使用 “Ireland”。'],
    normalized_string_match: [
      'This match depends on meaning, so it is not approved automatically.',
      '这不是简单的文字匹配，因此不会自动通过。',
    ],
    code_cooccurrence_consistency: [
      'There is no related-field rule for this column, so this check stays neutral.',
      '这一列没有可用的关联字段规则，因此此项保持中立。',
    ],
    grounding_validation: [
      'The suggestion uses only values and evidence found in this run.',
      '这条建议只使用本次运行中真实存在的取值和证据。',
    ],
  };
  const note = notes[signal];
  return note ? t(note[0], note[1]) : t(fallbackEn, fallbackZh);
}

function findingLabel(findingId: string, fallbackEn: string, fallbackZh: string, t: Translate): string {
  const labels: Record<string, [string, string]> = {
    'DUP-EXACT': ['500 duplicate records', '500 条重复记录'],
    'FMT-InvoiceDate': ['Dates use a different format', '日期格式不统一'],
    'SEM-Country': ['EIRE may mean Ireland', 'EIRE 可能就是 Ireland'],
    'AMB-Country': ['Channel Islands needs review', 'Channel Islands 需要确认'],
    'MISS-CustomerID': ['Customer IDs are missing', '部分 CustomerID 缺失'],
    'VAL-Quantity': ['798 quantities need review', '798 笔数量需要复核'],
    'VAL-UnitPrice': ['273 prices need review', '273 笔价格需要复核'],
  };
  const label = labels[findingId];
  return label ? t(label[0], label[1]) : t(fallbackEn, fallbackZh);
}

function actionLabel(actionType: string, column: string | null, t: Translate): string {
  const labels: Record<string, [string, string]> = {
    EXCLUDE_EXACT_DUPLICATE_FROM_RELEASE: ['Leave duplicate copies out', '排除重复副本'],
    STANDARDIZE_DATE_FORMAT: ['Use one date format', '统一日期格式'],
    NORMALIZE_CATEGORY: ['Standardise country names', '统一国家名称'],
    QUARANTINE_RECORDS: [
      column ? `Hold records with ${column} issues` : 'Hold affected records',
      column ? `隔离 ${column} 有问题的记录` : '隔离相关记录',
    ],
  };
  const label = labels[actionType];
  return label ? t(label[0], label[1]) : actionType;
}

function authorizationLabel(source: string, reference: string, findingId: string, t: Translate): string {
  return source === 'POLICY'
    ? t(`Policy rule · ${reference}`, `策略规则 · ${reference}`)
    : t(`Reviewer approval · ${findingId}`, `人工确认 · ${findingId}`);
}

function validationLabel(checkId: string, t: Translate): string {
  const labels: Record<string, [string, string]> = {
    SOURCE_IMMUTABLE: ['Source file unchanged', '源文件未改动'],
    SCOPE_STABLE: ['Scoring scope unchanged', '评分范围未改变'],
    EVALUATION_SCOPE_STABLE: ['Evaluation scope unchanged', '评估范围未改变'],
    COMPLETENESS_NOT_IMPUTED: ['Missing values were not hidden', '没有掩盖缺失值'],
    NO_UNAPPROVED_CELL_CHANGES: ['Only approved changes were made', '只执行了已批准的修改'],
  };
  const label = labels[checkId];
  return label ? t(label[0], label[1]) : checkId;
}

function metricLabel(name: string, t: Translate): string {
  const labels: Record<string, [string, string]> = {
    completeness: ['Completeness', '完整性'],
    validity: ['Validity', '有效性'],
    consistency: ['Consistency', '一致性'],
    uniqueness: ['Uniqueness', '唯一性'],
  };
  const label = labels[name];
  return label ? t(label[0], label[1]) : name;
}

function StepNavigation({ current, onChange }: { current: number; onChange: (step: number) => void }) {
  const { language, t } = useLanguage();
  return (
    <ol className="grid grid-cols-4 overflow-hidden rounded-xl border border-black/8 bg-white" aria-label={t('Demo chapters', '演示章节')}>
      {STEPS.map((item, index) => {
        const active = current === index;
        const completed = current > index;
        return (
          <li key={item.id} className="min-w-0 border-r border-black/7 last:border-r-0">
            <button
              type="button"
              onClick={() => onChange(index)}
              aria-current={active ? 'step' : undefined}
              aria-label={`${index + 1}. ${pick(language, item.zh, item.en)}`}
              className={cn(
                'flex min-h-14 w-full items-center justify-center gap-2 px-2 text-xs font-medium transition-colors sm:justify-start sm:px-4',
                active ? 'bg-ink text-white' : completed ? 'bg-policy-tint text-policy' : 'text-muted-foreground hover:bg-muted/60',
              )}
            >
              <span
                className={cn(
                  'grid size-5 shrink-0 place-items-center rounded-full border text-[10px]',
                  active ? 'border-white/30' : completed ? 'border-policy/25 bg-white' : 'border-border',
                )}
              >
                {completed ? <Check aria-hidden="true" className="size-3" /> : index + 1}
              </span>
              <span className="hidden truncate sm:inline">{pick(language, item.zh, item.en)}</span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

function FactsStep() {
  const { t } = useLanguage();
  const demo = boothDemo;
  const blockers = demo.findings.filter((finding) => finding.blocking);
  const riskCounts = {
    HIGH: demo.findings.filter((finding) => finding.risk_level === 'HIGH').length,
    MEDIUM: demo.findings.filter((finding) => finding.risk_level === 'MEDIUM').length,
    LOW: demo.findings.filter((finding) => finding.risk_level === 'LOW').length,
  };

  return (
    <div className="grid gap-8 lg:grid-cols-[0.82fr_1.18fr] lg:gap-12">
      <div>
        <SectionLabel>{t('Dataset health', '数据概览')}</SectionLabel>
        <div className="mt-4 flex items-baseline gap-2">
          <Score value={demo.quality.baseline.overall_score} />
          <span className="text-sm text-muted-foreground">/ 100</span>
        </div>
        <p className="mt-4 max-w-md text-sm leading-6 text-muted-foreground">
          {t(
            `${blockers.length} issues still need attention before this dataset can be shared, even though its overall quality looks healthy.`,
            `整体质量看起来不错，但仍有 ${blockers.length} 项问题需要处理后才能交付。`,
          )}
        </p>

        <div className="mt-7 grid grid-cols-2 gap-x-6 gap-y-6 border-t border-black/8 pt-6">
          <DataPoint value={formatInt(demo.source.record_count)} label={t('records checked', '已检查记录')} />
          <DataPoint value={formatInt(demo.source.column_count)} label={t('columns checked', '已检查字段')} />
          <DataPoint value={formatInt(demo.findings.length)} label={t('issues found', '发现问题')} />
          <DataPoint value={formatInt(blockers.length)} label={t('need action', '需要处理')} />
        </div>
      </div>

      <div className="overflow-hidden rounded-2xl border border-black/8 bg-[#fbfcfa]">
        <div className="flex items-center justify-between gap-4 border-b border-black/7 px-5 py-4">
          <div>
            <h3 className="text-sm font-semibold text-ink">{t('What needs attention', '哪些问题需要处理')}</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t('Found directly in the data—AI has not been used yet.', '直接从数据中发现，这一步还没有使用 AI。')}
            </p>
          </div>
          <span className="rounded-full bg-blocker-tint px-2.5 py-1 text-[11px] font-semibold text-blocker">
            {t('Not ready', '暂不可交付')}
          </span>
        </div>
        <div className="divide-y divide-black/7">
          {demo.findings.map((finding) => (
            <div key={finding.finding_id} className="grid grid-cols-[minmax(0,1fr)_auto] gap-4 px-5 py-3.5">
              <div className="min-w-0">
                <div className="truncate text-[13px] font-medium text-foreground">
                  {findingLabel(finding.finding_id, finding.title_en, finding.title_zh, t)}
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                  <span className="mono">{finding.finding_id}</span>
                  <span>{finding.column ?? t('record level', '记录级')}</span>
                  {finding.blocking ? <span className="font-medium text-blocker">{t('NEEDS ACTION', '需处理')}</span> : null}
                </div>
              </div>
              <div className="text-right">
                <div className="mono text-sm font-semibold">{formatInt(finding.affected_record_count)}</div>
                <div className="text-[10px] text-muted-foreground">{t('records', '条记录')}</div>
              </div>
            </div>
          ))}
        </div>
        <div className="flex items-center justify-between gap-3 border-t border-black/7 bg-white px-5 py-3 text-xs">
          <span className="text-muted-foreground">{t('By urgency', '按紧急程度')}</span>
          <span className="mono text-foreground">
            {t('HIGH', '高')} {riskCounts.HIGH} · {t('MEDIUM', '中')} {riskCounts.MEDIUM} · {t('LOW', '低')} {riskCounts.LOW}
          </span>
        </div>
      </div>
    </div>
  );
}

function ProposalStep() {
  const { t } = useLanguage();
  const finding = boothFinding('SEM-Country');
  const call = boothDemo.ai.calls[0];
  if (!finding || !finding.proposal || !call) return null;
  const mappings = Object.entries(finding.proposal.mapping ?? {});

  return (
    <div className="grid gap-8 lg:grid-cols-[1.12fr_0.88fr] lg:gap-12">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <SectionLabel>{t('One AI-assisted review', '一条 AI 辅助建议')}</SectionLabel>
          <span className="rounded-full bg-ai-tint px-2 py-0.5 text-[10px] font-semibold text-ai">AI</span>
        </div>
        <h2 className="mt-4 text-2xl font-semibold tracking-[-0.035em] text-ink sm:text-3xl">
          {t('AI spots a likely match. You stay in control.', 'AI 找到可能的同义项，最终决定仍由人来做。')}
        </h2>
        <p className="mt-3 max-w-xl text-sm leading-6 text-muted-foreground">
          {t(
            `${mappings[0]?.[0]} appears in ${formatInt(finding.affected_record_count)} records. AI linked it to the approved name ${mappings[0]?.[1]}, and DataPilot checked the evidence before asking for approval.`,
            `${mappings[0]?.[0]} 出现在 ${formatInt(finding.affected_record_count)} 条记录中。AI 建议统一为已批准名称 ${mappings[0]?.[1]}，DataPilot 会先核对证据，再交给人确认。`,
          )}
        </p>

        <div className="mt-7 overflow-hidden rounded-2xl border border-black/8 bg-white">
          <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-4 px-5 py-7 sm:px-8">
            <div>
              <div className="text-[11px] text-muted-foreground">{t('Current value', '当前写法')}</div>
              <div className="mono mt-1 text-xl font-semibold">{mappings[0]?.[0]}</div>
            </div>
            <ChevronRight aria-hidden="true" className="size-5 text-ai" />
            <div className="text-right">
              <div className="text-[11px] text-muted-foreground">{t('Suggested name', '建议名称')}</div>
              <div className="mono mt-1 text-xl font-semibold text-policy">{mappings[0]?.[1]}</div>
            </div>
          </div>
          <div className="grid grid-cols-2 border-t border-black/7 bg-[#fbfcfa] sm:grid-cols-4">
            <div className="border-r border-b border-black/7 px-4 py-3 sm:border-b-0">
              <div className="mono text-sm font-semibold">{formatInt(finding.affected_record_count)}</div>
              <div className="mt-0.5 text-[10px] text-muted-foreground">{t('records affected', '涉及记录')}</div>
            </div>
            <div className="border-b border-black/7 px-4 py-3 sm:border-r sm:border-b-0">
              <div className="mono text-sm font-semibold">{formatInt(call.redaction.rows_sent)}</div>
              <div className="mt-0.5 text-[10px] text-muted-foreground">{t('raw rows shared', '共享原始行')}</div>
            </div>
            <div className="border-r border-black/7 px-4 py-3">
              <div className="mono text-sm font-semibold">{formatInt(call.redaction.values_sent)}</div>
              <div className="mt-0.5 text-[10px] text-muted-foreground">{t('summary values shared', '共享汇总值')}</div>
            </div>
            <div className="px-4 py-3">
              <div className="mono text-sm font-semibold">{call.grounding.valid ? t('Passed', '通过') : t('Rejected', '拒绝')}</div>
              <div className="mt-0.5 text-[10px] text-muted-foreground">{t('evidence check', '证据核验')}</div>
            </div>
          </div>
        </div>
      </div>

      <aside className="rounded-2xl bg-ink p-5 text-white sm:p-6">
        <div className="flex items-center gap-2 text-xs font-medium text-white/65">
          <ShieldCheck aria-hidden="true" className="size-4" />
          {t('Why this suggestion is reviewable', '为什么这条建议值得审核')}
        </div>
        <ol className="mt-5 space-y-4">
          {finding.evidence_signals.map((signal, index) => (
            <li key={signal.evidence_ref} className="flex gap-3">
              <span className={cn('mt-0.5 grid size-5 shrink-0 place-items-center rounded-full text-[10px]', signal.status === 'PASS' ? 'bg-[#b7f1df] text-ink' : 'bg-white/10 text-white/70')}>
                {signal.status === 'PASS' ? <Check aria-hidden="true" className="size-3" /> : index + 1}
              </span>
              <div>
                <div className="text-xs font-medium text-white">{signalLabel(signal.signal, t)}</div>
                <p className="mt-1 text-[11px] leading-4 text-white/60">
                  {signalNote(signal.signal, signal.explanation_en, signal.explanation_zh, t)}
                </p>
              </div>
            </li>
          ))}
        </ol>
        <div className="mt-6 border-t border-white/12 pt-5">
          <div className="flex items-center justify-between gap-4 text-xs">
            <span className="text-white/60">{t('Next step', '下一步')}</span>
            <span className="rounded-full bg-[#fff1d8] px-2.5 py-1 font-semibold text-[#714400]">
              {t('Needs your approval', '需要人工确认')}
            </span>
          </div>
          <p className="mt-3 text-xs leading-5 text-white/65">
            {t(
              'In the recorded run, a reviewer approved this suggestion. Only then was it added to the release plan.',
              '在这次已完成的运行中，审核人确认了这条建议；确认后，它才被加入执行计划。',
            )}
          </p>
        </div>
      </aside>
    </div>
  );
}

function GovernanceStep() {
  const { t } = useLanguage();
  const demo = boothDemo;
  const policyActions = demo.governance.actions.filter((action) => action.authorization_source === 'POLICY');
  const humanActions = demo.governance.actions.filter((action) => action.authorization_source === 'HUMAN');
  const duplicateAction = demo.governance.actions.find((action) => action.finding_id === 'DUP-EXACT');

  return (
    <div className="grid gap-8 lg:grid-cols-[0.86fr_1.14fr] lg:gap-12">
      <div>
        <SectionLabel>{t('Decide what happens next', '决定如何处理')}</SectionLabel>
        <h2 className="mt-4 text-2xl font-semibold tracking-[-0.035em] text-ink sm:text-3xl">
          {t('Safe fixes move forward. Risky records stay out.', '能安全修的继续，风险记录先隔离。')}
        </h2>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          {t(
            `${policyActions.length} routine fixes were cleared by policy. ${humanActions.length} higher-impact choices were explicitly approved by a reviewer.`,
            `${policyActions.length} 项常规修正由策略自动放行，${humanActions.length} 项影响更大的处理由审核人逐项确认。`,
          )}
        </p>

        <div className="mt-7 rounded-2xl border border-black/8 bg-white p-5">
          <div className="flex items-center justify-between gap-4">
            <span className="text-sm font-semibold text-ink">{t('All issues have an outcome', '所有问题都已处理')}</span>
            <span className="mono text-sm font-semibold text-policy">
              {formatInt(Object.keys(demo.governance.finding_dispositions).length)}/{formatInt(demo.findings.length)}
            </span>
          </div>
          <div className="mt-3 h-2 overflow-hidden rounded-full bg-muted">
            <div className="h-full w-full rounded-full bg-policy" />
          </div>
          <div className="mt-5 grid grid-cols-3 gap-4 border-t border-black/7 pt-5">
            <DataPoint value={formatInt(policyActions.length)} label={t('cleared by policy', '策略自动通过')} />
            <DataPoint value={formatInt(humanActions.length)} label={t('reviewed by a person', '人工确认')} />
            <DataPoint value={formatInt(demo.release.quarantined_record_count)} label={t('records held back', '暂不交付')} />
          </div>
        </div>
      </div>

      <div className="overflow-hidden rounded-2xl border border-black/8 bg-[#fbfcfa]">
        <div className="border-b border-black/7 px-5 py-4">
          <h3 className="text-sm font-semibold text-ink">{t('Release plan', '执行计划')}</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {formatInt(demo.governance.actions.length)} {t('approved actions, ready to run', '项处理已获批准，可以执行')}
          </p>
        </div>
        <div className="divide-y divide-black/7">
          {demo.governance.actions.map((action) => (
            <div key={action.finding_id} className="flex items-center gap-3 px-5 py-3">
              <span className={cn('grid size-7 shrink-0 place-items-center rounded-lg', action.authorization_source === 'POLICY' ? 'bg-policy-tint text-policy' : 'bg-review-tint text-review')}>
                {action.authorization_source === 'POLICY' ? <ShieldCheck aria-hidden="true" className="size-3.5" /> : <UserCheck aria-hidden="true" className="size-3.5" />}
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs font-medium text-foreground">
                  {actionLabel(action.action_type, action.column, t)}
                </div>
                <div className="mt-0.5 truncate text-[10px] text-muted-foreground" title={action.authorization_ref}>
                  {authorizationLabel(action.authorization_source, action.authorization_ref, action.finding_id, t)}
                </div>
              </div>
              <span className="mono shrink-0 text-xs font-medium">{formatInt(action.affected_record_count)}</span>
            </div>
          ))}
        </div>
        <div className="border-t border-black/7 bg-white px-5 py-3 text-[11px] leading-4 text-muted-foreground">
          {t(
            `${duplicateAction?.affected_record_count ?? 0} duplicate copies were found. Some also had higher-priority issues, leaving ${demo.release.excluded_record_count} records excluded for duplication alone.`,
            `共发现 ${duplicateAction?.affected_record_count ?? 0} 条重复副本，其中一部分还存在更优先的问题；最终仅因重复而排除 ${demo.release.excluded_record_count} 条。`,
          )}
        </div>
      </div>
    </div>
  );
}

function ReleaseStep() {
  const { t, language } = useLanguage();
  const demo = boothDemo;
  const passed = demo.release.validation_summary.passed;
  const total = passed + demo.release.validation_summary.failed;

  return (
    <div>
      <div className="grid gap-8 lg:grid-cols-[0.76fr_1.24fr] lg:gap-12">
        <div>
          <SectionLabel>{t('Ready to share', '交付结果')}</SectionLabel>
          <div className="mt-4 inline-flex items-center gap-2 rounded-full bg-review-tint px-3 py-1.5 text-xs font-semibold text-review">
            <CircleAlert aria-hidden="true" className="size-3.5" />
            {t('Ready with exclusions', '可交付（含隔离）')}
          </div>
          <h2 className="mt-5 text-2xl font-semibold tracking-[-0.035em] text-ink sm:text-3xl">
            {t(
              `${formatInt(demo.release.eligible_record_count)} records are ready for use.`,
              `${formatInt(demo.release.eligible_record_count)} 条记录可以放心进入下游。`,
            )}
          </h2>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">
            {t(
              `Questionable records were kept separate and the source file was left untouched. The score still covers all ${formatInt(demo.source.record_count)} original records.`,
              `有疑问的记录已单独隔离，源文件没有被改动；质量分仍按全部 ${formatInt(demo.source.record_count)} 条原始记录计算。`,
            )}
          </p>

          <div className="mt-7 flex items-end gap-4 border-t border-black/8 pt-6">
            <div>
              <div className="text-[11px] text-muted-foreground">{t('Quality before', '处理前质量')}</div>
              <Score value={demo.quality.baseline.overall_score} small />
            </div>
            <ArrowRight aria-hidden="true" className="mb-1.5 size-4 text-muted-foreground" />
            <div>
              <div className="text-[11px] text-muted-foreground">{t('Quality after', '处理后质量')}</div>
              <Score value={demo.quality.candidate.overall_score} small />
            </div>
            <span className="mb-1 rounded-full bg-policy-tint px-2 py-1 text-[10px] font-semibold text-policy">
              +{(demo.quality.candidate.overall_score - demo.quality.baseline.overall_score).toFixed(2)}
            </span>
          </div>
        </div>

        <div className="rounded-2xl bg-ink p-5 text-white sm:p-7">
          <div className="flex items-center justify-between gap-4 border-b border-white/12 pb-5">
            <div>
              <div className="text-xs text-white/55">{t('Final checks', '交付前检查')}</div>
              <div className="mono mt-1 text-3xl font-semibold tracking-[-0.05em]">{passed}/{total}</div>
            </div>
            <span className="grid size-11 place-items-center rounded-full bg-[#b7f1df] text-ink">
              <CheckCircle2 aria-hidden="true" className="size-5" />
            </span>
          </div>
          <div className="mt-5 grid grid-cols-3 gap-4">
            <div>
              <div className="mono text-xl font-semibold">{formatInt(demo.release.eligible_record_count)}</div>
              <div className="mt-1 text-[10px] leading-4 text-white/55">{t('ready to share', '可以交付')}</div>
            </div>
            <div>
              <div className="mono text-xl font-semibold">{formatInt(demo.release.quarantined_record_count)}</div>
              <div className="mt-1 text-[10px] leading-4 text-white/55">{t('held for review', '留待复核')}</div>
            </div>
            <div>
              <div className="mono text-xl font-semibold">{formatInt(demo.release.excluded_record_count)}</div>
              <div className="mt-1 text-[10px] leading-4 text-white/55">{t('duplicates left out', '重复排除')}</div>
            </div>
          </div>
          <div className="mt-6 space-y-2 border-t border-white/12 pt-5">
            {demo.validations.slice(0, 5).map((validation) => (
              <div key={validation.check_id} className="flex items-center justify-between gap-3 text-xs">
                <span className="truncate text-white/70" title={validation.check_id}>
                  {validationLabel(validation.check_id, t)}
                </span>
                <span className="inline-flex items-center gap-1 text-[#b7f1df]">
                  <Check aria-hidden="true" className="size-3" /> {t('Passed', '通过')}
                </span>
              </div>
            ))}
            <div className="pt-1 text-[11px] text-white/45">
              + {formatInt(demo.validations.length - 5)} {t('additional checks', '项其他验证')}
            </div>
          </div>
        </div>
      </div>

      <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {demo.quality.baseline.metrics.map((metric) => {
          const candidate = demo.quality.candidate.metrics.find((item) => item.name === metric.name);
          return (
            <div key={metric.name} className="rounded-xl border border-black/8 bg-white px-4 py-3.5">
              <div className="text-[11px] font-medium text-muted-foreground">{metricLabel(metric.name, t)}</div>
              <div className="mt-2 flex items-baseline gap-2">
                <span className="mono text-base text-muted-foreground">{metric.score.toFixed(2)}</span>
                <ArrowRight aria-hidden="true" className="size-3" />
                <span className="mono text-lg font-semibold text-ink">{candidate?.score.toFixed(2)}</span>
              </div>
              <div className="mt-1 text-[10px] leading-4 text-muted-foreground">
                {pick(language, metric.scope_zh, metric.scope_en)}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function AuditDetails() {
  const { t } = useLanguage();
  const demo = boothDemo;
  const call = demo.ai.calls[0];
  return (
    <details className="group mt-6 overflow-hidden rounded-xl border border-black/8 bg-white">
      <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-4 px-4 text-xs font-medium text-foreground marker:hidden">
        <span className="inline-flex items-center gap-2">
          <Fingerprint aria-hidden="true" className="size-4 text-policy" />
          {t('View technical proof and audit details', '查看技术凭证与审计记录')}
        </span>
        <ChevronRight aria-hidden="true" className="size-4 text-muted-foreground transition-transform group-open:rotate-90" />
      </summary>
      <div className="grid gap-5 border-t border-black/7 px-4 py-5 text-xs md:grid-cols-2 lg:grid-cols-3">
        <div className="space-y-3">
          <div className="font-semibold">{t('Input data', '输入数据')}</div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-muted-foreground">SHA-256</span>
            <HashChip value={demo.source.sha256} length={10} />
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-muted-foreground">scope</span>
            <HashChip value={demo.provenance.scope_hash} length={10} />
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-muted-foreground">contract</span>
            <HashChip value={demo.provenance.contract_hash} length={10} />
          </div>
        </div>
        <div className="space-y-3">
          <div className="font-semibold">{t('AI call record', 'AI 调用记录')}</div>
          <div className="flex justify-between gap-3"><span className="text-muted-foreground">provider</span><span className="mono">{call?.provider}</span></div>
          <div className="flex justify-between gap-3"><span className="text-muted-foreground">model served</span><span className="mono max-w-44 truncate" title={call?.model_served ?? undefined}>{call?.model_served}</span></div>
          <div className="flex justify-between gap-3"><span className="text-muted-foreground">prompt</span><span className="mono">{call?.prompt_version}</span></div>
          <div className="flex items-center justify-between gap-3"><span className="text-muted-foreground">input</span><HashChip value={call?.input_hash} length={10} /></div>
        </div>
        <div className="space-y-3">
          <div className="font-semibold">{t('Output files', '输出文件')}</div>
          <div className="flex items-center justify-between gap-3"><span className="text-muted-foreground">candidate</span><HashChip value={demo.release.candidate_artifact_hash} length={10} /></div>
          <div className="flex items-center justify-between gap-3"><span className="text-muted-foreground">release</span><HashChip value={demo.release.release_artifact_hash} length={10} /></div>
          <div className="flex items-center justify-between gap-3"><span className="text-muted-foreground">ledger</span><HashChip value={demo.release.change_ledger_hash} length={10} /></div>
          <div className="flex justify-between gap-3"><span className="text-muted-foreground">run</span><span className="mono max-w-44 truncate" title={demo.run.run_id}>{demo.run.run_id}</span></div>
        </div>
      </div>
    </details>
  );
}

export function BoothExperience() {
  const { t } = useLanguage();
  const [step, setStep] = useState(0);
  const demo = boothDemo;

  return (
    <div className="min-h-[calc(100dvh-var(--shell-header-height))] bg-[linear-gradient(180deg,#f7f8f5_0%,#eef3f1_100%)]">
      <div className="mx-auto w-full max-w-6xl px-4 pt-6 pb-16 sm:px-8 sm:pt-9 lg:px-10">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-review-tint px-2.5 py-1 text-[11px] font-semibold text-review">
                <RotateCcw aria-hidden="true" className="size-3" />
                {t('Verified replay · not live', '已验证回放 · 非实时运行')}
              </span>
              <span className="text-[11px] text-muted-foreground">{t('Opens instantly · no API or AI call', '即开即看 · 不调用 API 或 AI')}</span>
            </div>
            <h1 className="mt-3 text-2xl font-semibold tracking-[-0.035em] text-ink sm:text-3xl">
              {t('From raw transactions to a safe handoff in 3 minutes', '3 分钟，看一份数据如何通过交付审核')}
            </h1>
            <p className="mt-2 text-sm text-muted-foreground">
              {t(demo.source.title_en, demo.source.title_zh)} · {formatInt(demo.source.record_count)} × {formatInt(demo.source.column_count)}
            </p>
          </div>
          <a
            href={demo.source.source_url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex min-h-11 items-center gap-1.5 self-start text-xs font-medium text-foreground underline-offset-4 hover:underline"
          >
            <Database aria-hidden="true" className="size-3.5" />
            UCI · {demo.source.license}
            <ExternalLink aria-hidden="true" className="size-3" />
          </a>
        </div>

        <div className="mt-6">
          <StepNavigation current={step} onChange={setStep} />
        </div>

        <main className="mt-4 rounded-2xl border border-black/8 bg-white p-5 shadow-[0_20px_70px_rgba(16,35,30,0.06)] sm:p-8 lg:p-10">
          {step === 0 ? <FactsStep /> : null}
          {step === 1 ? <ProposalStep /> : null}
          {step === 2 ? <GovernanceStep /> : null}
          {step === 3 ? <ReleaseStep /> : null}
        </main>

        <div className="mt-4 flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={() => setStep((value) => Math.max(0, value - 1))}
            disabled={step === 0}
            className={cn(buttonVariants({ variant: 'ghost', size: 'lg' }), 'h-11 px-3 disabled:invisible')}
          >
            <ArrowLeft aria-hidden="true" />
            {t('Previous', '上一步')}
          </button>
          {step < STEPS.length - 1 ? (
            <button
              type="button"
              onClick={() => setStep((value) => Math.min(STEPS.length - 1, value + 1))}
              aria-label={
                step === 0
                  ? t('See how AI helps', '看看 AI 如何协助')
                  : step === 1
                    ? t('See the review decisions', '查看审核决定')
                    : t('See the final result', '查看交付结果')
              }
              className={cn(buttonVariants({ size: 'lg' }), 'h-11 rounded-xl px-4')}
            >
              <span className="sm:hidden">{t('Next', '下一步')}</span>
              <span className="hidden sm:inline">
                {step === 0
                  ? t('See how AI helps', '看看 AI 如何协助')
                  : step === 1
                    ? t('See the review decisions', '查看审核决定')
                    : t('See the final result', '查看交付结果')}
              </span>
              <ArrowRight aria-hidden="true" />
            </button>
          ) : (
            <Link href="/workbench" className={cn(buttonVariants({ size: 'lg' }), 'h-11 rounded-xl px-4')}>
              <span className="sm:hidden">{t('Try yours', '分析我的数据')}</span>
              <span className="hidden sm:inline">{t('Analyse your own CSV', '分析自己的 CSV')}</span>
              <ArrowRight aria-hidden="true" />
            </Link>
          )}
        </div>

        <AuditDetails />

        <div className="mt-5 flex flex-col gap-3 text-[11px] leading-4 text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          <span className="inline-flex items-center gap-1.5">
            <LockKeyhole aria-hidden="true" className="size-3.5" />
            {t('This replay shows summary results only; no source rows are included.', '回放只展示汇总结果，不包含任何源数据行。')}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <FileCheck2 aria-hidden="true" className="size-3.5" />
            {formatInt(demo.verification.checks.length)} {t('independent checks passed', '项独立复验通过')}
          </span>
        </div>
      </div>
    </div>
  );
}
