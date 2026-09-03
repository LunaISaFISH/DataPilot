'use client';

import {
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronRight,
  FileCheck2,
  FlaskConical,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { LanguageToggle } from '@/components/language-toggle';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import {
  type ExecutionResult,
  type Finding,
  formatLabel,
  type RunReport,
  shortHash,
} from '@/lib/datapilot';
import { useLanguage } from '@/lib/language';

type Stage = 'start' | 'processing' | 'brief' | 'semantic' | 'risks' | 'changes' | 'report';
type ReplayEvent = { stage: string; status: string; message: string };

const STORAGE_KEY = 'datapilot-demo-stage-v1';
const riskFindingIds = ['SEM-004-CONFLICT', 'AMB-005', 'MISS-006', 'PHI-007'];
const zhLabels: Record<string, string> = {
  completeness: '完整性',
  validity: '有效性',
  consistency: '一致性',
  uniqueness: '唯一性',
  canonical_glossary_match: '规范术语匹配',
  normalized_string_match: '规范化字符串匹配',
  code_cooccurrence_consistency: '代码共现一致性',
  distribution_stability: '分布稳定性',
  NORMALIZE_CATEGORY: '规范化类别',
  STANDARDIZE_DATE_FORMAT: '统一日期格式',
  EXCLUDE_EXACT_DUPLICATE_FROM_RELEASE: '从发布版本排除完全重复记录',
  EXCLUDE_COLUMN_FROM_RELEASE: '从发布版本排除字段',
  QUARANTINE_RECORDS: '隔离记录',
  POLICY: '策略授权',
  HUMAN: '人工授权',
  CONDITIONAL_PASS: '有条件通过',
  BLOCKED: '已阻断',
  PASS: '通过',
};

const zhFindingTitles: Record<string, string> = {
  'SEM-004': '诊断标签语义变体',
  'SEM-004-CONFLICT': '诊断标签与代码存在冲突',
  'AMB-005': '已知多义临床缩写',
  'MISS-006': '必填诊断代码缺失',
  'PHI-007': '自由文本中检测到直接标识符',
};

function localizeLabel(value: string, language: 'en' | 'zh') {
  return language === 'zh' ? (zhLabels[value] ?? formatLabel(value)) : formatLabel(value);
}

function localizeFindingTitle(finding: Finding, language: 'en' | 'zh') {
  return language === 'zh' ? (zhFindingTitles[finding.finding_id] ?? finding.title) : finding.title;
}

function localizeRiskEvidence(finding: Finding, language: 'en' | 'zh') {
  if (language === 'en') return finding.evidence_signals[0]?.explanation;
  return {
    'SEM-004-CONFLICT': '该记录的诊断代码与候选语义映射冲突，已从映射范围中剔除。',
    'AMB-005': '命中多义缩写登记表，AI 已主动放弃归一。',
    'MISS-006': '必填诊断代码缺失，自动填补可能引入错误业务含义。',
    'PHI-007': '检测到直接标识符模式；原始证据已遮蔽，且未发送给 AI。',
  }[finding.finding_id];
}

function localizeEvidence(signal: Finding['evidence_signals'][number], language: 'en' | 'zh') {
  if (language === 'en') return signal.explanation;
  return {
    canonical_glossary_match: '候选值与策略包中的规范术语及别名一致。',
    normalized_string_match: '大小写、空白和 Unicode 规范化结果一致。',
    code_cooccurrence_consistency: '适用记录中的诊断代码共现关系一致。',
    distribution_stability: '应用映射不会造成异常的类别分布漂移。',
  }[signal.signal] ?? signal.explanation;
}

function StatusBadge({ risk }: { risk: Finding['risk_level'] }) {
  const { t } = useLanguage();
  const style =
    risk === 'HIGH'
      ? 'bg-[#fbe9e7] text-blocker ring-blocker/15'
      : risk === 'MEDIUM'
        ? 'bg-[#fff1d8] text-review ring-review/15'
        : 'bg-policy-tint text-policy ring-policy/15';
  return (
    <Badge className={`${style} ring-1`}>
      {risk === 'HIGH' && <ShieldAlert aria-hidden="true" />}
      {risk === 'HIGH' ? t('HIGH', '高风险') : risk === 'MEDIUM' ? t('MEDIUM', '中风险') : t('LOW', '低风险')}
    </Badge>
  );
}

function Shell({
  children,
  stage,
  onBack,
}: {
  children: React.ReactNode;
  stage: Stage;
  onBack?: () => void;
}) {
  const { t } = useLanguage();
  const stageLabel: Record<Stage, string> = {
    start: t('Start', '开始'),
    processing: t('Processing', '处理中'),
    brief: t('Brief', '摘要'),
    semantic: t('Semantic review', '语义审查'),
    risks: t('Risk review', '风险审查'),
    changes: t('Change set', '变更集'),
    report: t('Report', '报告'),
  };
  return (
    <main className="min-h-dvh bg-background pb-[calc(24px+env(safe-area-inset-bottom))] text-foreground">
      <header className="sticky top-0 z-30 border-b border-border/90 bg-background/95 backdrop-blur">
        <div className="mx-auto flex min-h-16 w-full max-w-3xl items-center justify-between px-4">
          <div className="flex items-center gap-2.5">
            {onBack ? (
              <Button
                aria-label={t('Go back', '返回')}
                variant="ghost"
                size="icon"
                className="size-11 rounded-xl"
                onClick={onBack}
              >
                <ArrowLeft aria-hidden="true" />
              </Button>
            ) : (
              <span className="grid size-9 place-items-center rounded-xl bg-primary text-white">
                <ShieldCheck aria-hidden="true" className="size-5" />
              </span>
            )}
            <div>
              <p className="text-sm font-semibold">DataPilot</p>
              <p className="text-[11px] text-muted-foreground">{t('Clinical Evidence Desk', '临床证据工作台')}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Badge className="hidden bg-ai/10 text-ai ring-1 ring-ai/15 sm:inline-flex">{t('Verified Demo Replay', '已验证演示回放')}</Badge>
            <LanguageToggle />
          </div>
        </div>
      </header>
      <div className="mx-auto w-full max-w-3xl px-4 py-5 sm:py-8">
        <div className="mb-5 flex items-center justify-between gap-3">
          <p className="font-mono text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
            {t('Synthetic · non-clinical', '合成数据 · 非真实临床数据')}
          </p>
          <p className="font-mono text-[11px] text-muted-foreground">{stageLabel[stage]}</p>
        </div>
        {children}
      </div>
    </main>
  );
}

export function DemoExperience() {
  const { language, t } = useLanguage();
  const [analysis, setAnalysis] = useState<RunReport | null>(null);
  const [execution, setExecution] = useState<ExecutionResult | null>(null);
  const [events, setEvents] = useState<ReplayEvent[]>([]);
  const [stage, setStage] = useState<Stage>('start');
  const [eventIndex, setEventIndex] = useState(0);
  const [ruleApproved, setRuleApproved] = useState(false);
  const [resolvedRisks, setResolvedRisks] = useState<Set<string>>(new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);

  useEffect(() => {
    void Promise.all([
      fetch('/demo/report.json').then((response) => response.json() as Promise<RunReport>),
      fetch('/demo/release-report.json').then(
        (response) => response.json() as Promise<ExecutionResult>,
      ),
      fetch('/demo/events.json').then((response) => response.json() as Promise<ReplayEvent[]>),
    ])
      .then(([nextAnalysis, nextExecution, nextEvents]) => {
        setAnalysis(nextAnalysis);
        setExecution(nextExecution);
        setEvents(nextEvents);
      })
      .catch(() => {
        setStage('start');
      });
    const stored = window.sessionStorage.getItem(STORAGE_KEY);
    if (stored) {
      window.setTimeout(() => {
        const restored = JSON.parse(stored) as {
          stage: Stage;
          ruleApproved: boolean;
          resolvedRisks: string[];
        };
        setStage(restored.stage);
        setRuleApproved(restored.ruleApproved);
        setResolvedRisks(new Set(restored.resolvedRisks));
      }, 0);
    }
  }, []);

  useEffect(() => {
    if (stage !== 'processing' || events.length === 0) return;
    if (eventIndex >= events.length - 1) {
      const complete = window.setTimeout(() => setStage('brief'), 600);
      return () => window.clearTimeout(complete);
    }
    const timer = window.setTimeout(() => setEventIndex((current) => current + 1), 520);
    return () => window.clearTimeout(timer);
  }, [eventIndex, events.length, stage]);

  useEffect(() => {
    if (stage !== 'processing') {
      window.sessionStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ stage, ruleApproved, resolvedRisks: [...resolvedRisks] }),
      );
    }
  }, [resolvedRisks, ruleApproved, stage]);

  const semantic = useMemo(
    () => analysis?.findings.find((finding) => finding.finding_id === 'SEM-004') ?? null,
    [analysis],
  );
  const risks = useMemo(
    () =>
      analysis?.findings.filter((finding) => riskFindingIds.includes(finding.finding_id)) ?? [],
    [analysis],
  );

  if (!analysis || !execution) {
    return (
      <Shell stage="start">
        <Card className="border border-border bg-card ring-0">
          <CardContent className="flex min-h-64 items-center justify-center text-sm text-muted-foreground">
            {t('Loading verified engine report…', '正在载入已验证的引擎报告…')}
          </CardContent>
        </Card>
      </Shell>
    );
  }

  if (stage === 'start') {
    return (
      <Shell stage={stage}>
        <section className="space-y-5">
          <div>
            <p className="font-mono text-xs font-semibold uppercase tracking-[0.14em] text-primary">
              {t('Release candidate', '发布候选')}
            </p>
            <h1 className="mt-2 text-2xl font-semibold leading-tight tracking-[-0.025em] sm:text-3xl">
              {t('Can this dataset ship today?', '这份数据今天能发布吗？')}
            </h1>
            <p className="mt-2 max-w-xl text-sm leading-6 text-muted-foreground sm:text-base">
              {t(
                'Inspect a real engine report, review bounded actions, and create a verified release.',
                '查看真实引擎报告，审查受限动作，并生成经过验证的发布版本。',
              )}
            </p>
          </div>
          <Card className="border border-border bg-card ring-0">
            <CardHeader className="border-b border-border">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <CardTitle className="text-lg">{t('Clinical NLP release candidate', '临床 NLP 发布候选')}</CardTitle>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {t('Policy Pack', '策略包')} clinical-nlp · v1.0.0
                  </p>
                </div>
                <FlaskConical aria-label={t('Synthetic dataset', '合成数据集')} className="size-6 text-ai" />
              </div>
            </CardHeader>
            <CardContent className="grid grid-cols-3 gap-2 pt-1">
              {[
                [t('Records', '记录'), analysis.profile.record_count.toLocaleString()],
                [t('Fields', '字段'), analysis.profile.column_count.toString()],
                [t('Engine', '引擎'), analysis.engine_version],
              ].map(([label, value]) => (
                <div key={label} className="rounded-xl bg-muted/65 p-3">
                  <p className="text-[11px] text-muted-foreground">{label}</p>
                  <p className="mt-1 font-mono text-sm font-semibold">{value}</p>
                </div>
              ))}
            </CardContent>
          </Card>
          <Button
            size="lg"
            className="min-h-12 w-full rounded-[14px]"
            onClick={() => {
              setEventIndex(0);
              setStage('processing');
            }}
          >
            {t('Analyze release candidate', '分析发布候选')}
            <ArrowRight data-icon="inline-end" aria-hidden="true" />
          </Button>
        </section>
      </Shell>
    );
  }

  if (stage === 'processing') {
    return (
      <Shell stage={stage}>
        <section className="pt-6">
          <p className="font-mono text-xs font-semibold uppercase tracking-[0.14em] text-ai">
            {t('Engine', '引擎')} {analysis.engine_version} · {shortHash(analysis.profile.dataset_hash)}
          </p>
          <h1 className="mt-2 text-2xl font-semibold tracking-[-0.025em]">{t('Building a quality brief', '正在生成质量摘要')}</h1>
          <p className="mt-2 text-sm text-muted-foreground">{t('Rules first. Semantic analysis second.', '先执行规则，再进行语义分析。')}</p>
          <ol className="mt-8 space-y-3">
            {events.map((event, index) => {
              const complete = index <= eventIndex;
              return (
                <li
                  key={event.stage}
                  className={`flex min-h-14 items-center gap-3 rounded-xl border px-4 transition-colors ${complete ? 'border-policy/20 bg-policy-tint' : 'border-border bg-card text-muted-foreground'}`}
                >
                  <span
                    className={`grid size-7 shrink-0 place-items-center rounded-full ${complete ? 'bg-policy text-white' : 'bg-muted'}`}
                  >
                    {complete ? <Check aria-hidden="true" className="size-4" /> : index + 1}
                  </span>
                  <span className="text-sm font-medium">
                    {language === 'zh'
                      ? ({
                          INGESTING: '已安全接收 5,200 条记录',
                          PROFILING: '已完成 18 个字段画像',
                          DETECTING: '确定性检查已完成',
                          SEMANTIC_ANALYSIS: '已评估受限语义证据',
                          REVIEW_REQUIRED: '发布摘要已就绪',
                        }[event.stage] ?? event.message)
                      : event.message}
                  </span>
                </li>
              );
            })}
          </ol>
          <Button
            variant="ghost"
            className="mt-5 min-h-11 w-full"
            onClick={() => setStage('brief')}
          >
            {t('Skip replay', '跳过回放')}
          </Button>
        </section>
      </Shell>
    );
  }

  if (stage === 'brief') {
    const highCount = analysis.findings.filter((finding) => finding.risk_level === 'HIGH').length;
    return (
      <Shell stage={stage} onBack={() => setStage('start')}>
        <section>
          <div className="flex items-start justify-between gap-4">
            <div>
              <Badge className="bg-[#fbe9e7] text-blocker ring-1 ring-blocker/15">
                <ShieldAlert aria-hidden="true" /> {t('Release blocked', '发布已阻断')}
              </Badge>
              <h1 className="mt-2 text-2xl font-semibold tracking-[-0.025em]">{t('Quality brief', '质量摘要')}</h1>
              <p className="mt-2 text-sm text-muted-foreground">
                {t('High quality does not override unresolved release blockers.', '质量分再高，也不能绕过尚未处置的发布阻断项。')}
              </p>
            </div>
            <div className="text-right">
              <p className="font-mono text-4xl font-semibold">{analysis.profile.overall_score}</p>
              <p className="text-xs text-muted-foreground">{t('Baseline quality', '基线质量')}</p>
            </div>
          </div>
          <div className="mt-6 grid grid-cols-2 gap-2">
            {analysis.profile.metrics.map((metric) => (
              <Card key={metric.name} className="border border-border bg-card py-3 ring-0">
                <CardContent className="px-3">
                  <div className="flex items-end justify-between gap-2">
                    <p className="text-xs text-muted-foreground">{localizeLabel(metric.name, language)}</p>
                    <p className="font-mono text-lg font-semibold">{metric.score ?? 'N/A'}</p>
                  </div>
                  <p className="mt-2 font-mono text-[10px] text-muted-foreground">
                    {metric.numerator.toLocaleString()} / {metric.denominator.toLocaleString()}
                  </p>
                </CardContent>
              </Card>
            ))}
          </div>
          <Card className="mt-4 border border-border bg-card ring-0">
            <CardContent className="grid grid-cols-3 gap-2 pt-0">
              {[
                [t('Atomic findings', '独立问题'), analysis.findings.length],
                [t('Blockers', '阻断项'), highCount],
                [t('Policy-safe', '策略可授权'), analysis.findings.filter((item) => item.risk_level === 'LOW').length],
              ].map(([label, value]) => (
                <div key={label} className="text-center">
                  <p className="font-mono text-xl font-semibold">{value}</p>
                  <p className="mt-1 text-[11px] text-muted-foreground">{label}</p>
                </div>
              ))}
            </CardContent>
          </Card>
          <button
            type="button"
            className="mt-4 flex min-h-20 w-full items-center justify-between rounded-[16px] border border-ai/20 bg-white p-4 text-left shadow-sm focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ai/25"
            onClick={() => setStage('semantic')}
          >
            <span>
              <span className="flex items-center gap-2 text-xs font-semibold text-ai">
                <Sparkles aria-hidden="true" className="size-4" /> {t('Prioritized semantic review', '优先语义审查')}
              </span>
              <span className="mt-1 block font-semibold">{semantic ? localizeFindingTitle(semantic, language) : null}</span>
            </span>
            <ChevronRight aria-hidden="true" className="size-5 text-ai" />
          </button>
          <p className="mt-4 text-center font-mono text-[10px] text-muted-foreground">
            {t('Scope', '范围')} {shortHash(analysis.profile.scope_hash)} · {analysis.profile.score_version}
          </p>
        </section>
      </Shell>
    );
  }

  if (stage === 'semantic' && semantic) {
    const observed = semantic.details.observed_counts as Record<string, number>;
    return (
      <Shell stage={stage} onBack={() => setStage('brief')}>
        <section>
          <StatusBadge risk={semantic.risk_level} />
          <h1 className="mt-2 text-2xl font-semibold tracking-[-0.025em]">{t('Explainable semantic proposal', '可解释的语义提议')}</h1>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            {t(
              'The canonical target comes from the approved glossary. The engine recomputed the eligible scope.',
              '规范值来自已批准的术语表，实际适用范围由引擎重新计算。',
            )}
          </p>
          <div className="mt-5 grid gap-2">
            {Object.entries(observed).map(([value, count]) => (
              <div key={value} className="flex items-center justify-between rounded-xl border border-border bg-card px-4 py-3">
                <code className="text-sm">{value.replace(/ $/, ' ␠')}</code>
                <span className="font-mono text-xs text-muted-foreground">{count} {t('cells', '个单元格')}</span>
              </div>
            ))}
          </div>
          <div className="my-3 flex justify-center text-ai">
            <ArrowRight aria-hidden="true" className="rotate-90" />
          </div>
          <Card className="border border-ai/25 bg-[#f3f4ff] ring-0">
            <CardContent className="pt-0">
              <p className="text-xs font-semibold text-ai">{t('AI suggestion · validated scope', 'AI 提议 · 范围已验证')}</p>
              <p className="mt-2 text-xl font-semibold">{t('Normalize to “Hypertension”', '规范为 “Hypertension”')}</p>
              <p className="mt-1 text-sm text-muted-foreground">
                {t(
                  `${semantic.affected_cell_count} cells across ${semantic.affected_record_count} records`,
                  `${semantic.affected_cell_count} 个单元格，涉及 ${semantic.affected_record_count} 条记录`,
                )}
              </p>
            </CardContent>
          </Card>
          <div className="mt-4 space-y-2">
            {semantic.evidence_signals.map((signal) => (
              <div key={signal.signal} className="flex gap-3 rounded-xl bg-card p-3">
                <CheckCircle2 aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-policy" />
                <div>
                  <p className="text-sm font-medium">{localizeLabel(signal.signal, language)}</p>
                  <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{localizeEvidence(signal, language)}</p>
                </div>
              </div>
            ))}
          </div>
          {ruleApproved ? (
            <Card className="mt-4 border border-policy/25 bg-policy-tint ring-0">
              <CardContent className="pt-0">
                <p className="font-mono text-xs font-semibold text-policy">{t('RULE NORM-014 CREATED', '已创建规则 NORM-014')}</p>
                <p className="mt-2 text-lg font-semibold">{t('Human-approved · Not applied yet', '人工已批准 · 尚未应用')}</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {t('Reversible', '可回退')} · {semantic.affected_record_count} {t('records', '条记录')}
                </p>
              </CardContent>
            </Card>
          ) : null}
          <Button
            size="lg"
            className="mt-5 min-h-12 w-full rounded-[14px]"
            onClick={() => {
              if (ruleApproved) setStage('risks');
              else setRuleApproved(true);
            }}
          >
            {ruleApproved ? t('Review high-risk findings', '审查高风险问题') : t('Approve bounded rule', '批准受限规则')}
            <ArrowRight data-icon="inline-end" aria-hidden="true" />
          </Button>
        </section>
      </Shell>
    );
  }

  if (stage === 'risks') {
    const allResolved = risks.every((finding) => resolvedRisks.has(finding.finding_id));
    return (
      <Shell stage={stage} onBack={() => setStage('semantic')}>
        <section>
          <Badge className="bg-[#fff1d8] text-review ring-1 ring-review/15">
            {t('Human release decisions', '人工发布决策')}
          </Badge>
          <h1 className="mt-2 text-2xl font-semibold tracking-[-0.025em]">{t('Resolve the blockers', '处置发布阻断项')}</h1>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            {t('High-risk business meaning is never inferred automatically.', '系统绝不会自动推断高风险业务含义。')}
          </p>
          <div className="mt-5 space-y-3">
            {risks.map((finding) => {
              const resolved = resolvedRisks.has(finding.finding_id);
              const isPhi = finding.finding_id === 'PHI-007';
              return (
                <Card key={finding.finding_id} className="border border-border bg-card ring-0">
                  <CardHeader className="pb-2">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="font-mono text-[10px] text-muted-foreground">
                          {finding.finding_id}
                        </p>
                        <CardTitle className="mt-1 text-base">{localizeFindingTitle(finding, language)}</CardTitle>
                      </div>
                      <StatusBadge risk="HIGH" />
                    </div>
                  </CardHeader>
                  <CardContent>
                    <p className="text-sm leading-6 text-muted-foreground">
                      {localizeRiskEvidence(finding, language)}
                    </p>
                    <Button
                      variant={resolved ? 'secondary' : 'outline'}
                      className="mt-3 min-h-11 w-full justify-between"
                      onClick={() =>
                        setResolvedRisks((current) => new Set(current).add(finding.finding_id))
                      }
                    >
                      {resolved
                        ? isPhi
                          ? t('Field excluded from release', '字段已从发布版本排除')
                          : t('Records quarantined', '记录已隔离')
                        : isPhi
                          ? t('Exclude optional field', '排除非必要字段')
                          : t(
                              `Quarantine ${finding.affected_record_count} record${finding.affected_record_count === 1 ? '' : 's'}`,
                              `隔离 ${finding.affected_record_count} 条记录`,
                            )}
                      {resolved ? <Check data-icon="inline-end" /> : <ChevronRight data-icon="inline-end" />}
                    </Button>
                  </CardContent>
                </Card>
              );
            })}
          </div>
          <Button
            size="lg"
            disabled={!allResolved}
            className="mt-5 min-h-12 w-full rounded-[14px]"
            onClick={() => setStage('changes')}
          >
            {t('Review change set', '审查变更集')}
            <ArrowRight data-icon="inline-end" aria-hidden="true" />
          </Button>
        </section>
      </Shell>
    );
  }

  if (stage === 'changes') {
    const dryRun = execution.dry_run;
    return (
      <Shell stage={stage} onBack={() => setStage('risks')}>
        <section>
          <Badge className="bg-policy-tint text-policy ring-1 ring-policy/15">
            {Object.keys(dryRun.finding_dispositions).length}/{analysis.findings.length} {t('dispositioned', '已处置')}
          </Badge>
          <h1 className="mt-2 text-2xl font-semibold tracking-[-0.025em]">{t('Change set ready', '变更集已就绪')}</h1>
          <p className="mt-2 text-sm text-muted-foreground">{t('Dry run complete · Not applied yet', '预演完成 · 尚未应用')}</p>
          <div className="mt-5 space-y-2">
            {dryRun.actions.map((action) => (
              <div key={action.finding_id} className="rounded-xl border border-border bg-card p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold">{localizeLabel(action.action_type, language)}</p>
                    <p className="mt-1 font-mono text-[10px] text-muted-foreground">
                      {action.finding_id} · {action.authorization_ref}
                    </p>
                  </div>
                  <Badge variant="outline">{localizeLabel(action.authorization_source, language)}</Badge>
                </div>
              </div>
            ))}
          </div>
          <div className="mt-4 grid grid-cols-3 gap-2">
            {[
              [t('Eligible', '可发布'), dryRun.eligible_record_count],
              [t('Quarantine', '隔离'), dryRun.quarantined_record_count],
              [t('Excluded', '排除'), dryRun.excluded_record_count],
            ].map(([label, value]) => (
              <div key={label} className="rounded-xl bg-muted p-3 text-center">
                <p className="font-mono text-lg font-semibold">{Number(value).toLocaleString()}</p>
                <p className="text-[10px] text-muted-foreground">{label}</p>
              </div>
            ))}
          </div>
          <Button
            size="lg"
            className="mt-5 min-h-12 w-full rounded-[14px]"
            onClick={() => setConfirmOpen(true)}
          >
            {t('Apply & verify', '应用并验证')}
            <FileCheck2 data-icon="inline-end" aria-hidden="true" />
          </Button>
          <Sheet open={confirmOpen} onOpenChange={setConfirmOpen}>
            <SheetContent side="bottom" className="mx-auto max-h-[85dvh] max-w-3xl rounded-t-[24px] border-border">
              <SheetHeader className="px-5 pt-6">
                <SheetTitle className="text-2xl font-semibold">{t('Create verified candidate?', '生成已验证的候选版本？')}</SheetTitle>
                <SheetDescription className="mt-2 leading-6">
                  {t(
                    'The source artifact remains unchanged. DataPilot will execute the approved action set, run required validations, and publish only if every gate passes.',
                    '源数据保持不变。DataPilot 将执行已批准的动作集，完成必要验证，并且只在所有门禁通过后发布。',
                  )}
                </SheetDescription>
              </SheetHeader>
              <div className="mx-5 rounded-xl bg-muted p-4">
                <p className="font-mono text-xs">{t('Action set', '动作集')} {shortHash(dryRun.approved_action_set_hash)}</p>
                <p className="mt-2 text-sm text-muted-foreground">
                  {t(
                    `${dryRun.actions.length} actions · ${dryRun.affected_cell_count} transformed cells`,
                    `${dryRun.actions.length} 个动作 · 转换 ${dryRun.affected_cell_count} 个单元格`,
                  )}
                </p>
              </div>
              <SheetFooter className="px-5 pb-[calc(20px+env(safe-area-inset-bottom))]">
                <Button
                  size="lg"
                  className="min-h-12 w-full rounded-[14px]"
                  onClick={() => {
                    setConfirmOpen(false);
                    setStage('report');
                  }}
                >
                  {t('Create candidate & verify', '生成候选并验证')}
                </Button>
                <Button variant="ghost" className="min-h-11" onClick={() => setConfirmOpen(false)}>
                  {t('Keep reviewing', '继续审查')}
                </Button>
              </SheetFooter>
            </SheetContent>
          </Sheet>
        </section>
      </Shell>
    );
  }

  const manifest = execution.release_manifest;
  return (
    <Shell stage="report">
      <section>
        <div className="grid size-12 place-items-center rounded-2xl bg-policy text-white">
          <CheckCircle2 aria-hidden="true" className="size-7" />
        </div>
        <Badge className="mt-4 bg-policy-tint text-policy ring-1 ring-policy/15">
          {localizeLabel(manifest.release_status, language)}
        </Badge>
        <h1 className="mt-2 text-2xl font-semibold tracking-[-0.025em]">{t('Candidate verified', '候选版本已验证')}</h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          {t('All required checks passed. Exclusions remain visible in the release manifest.', '所有必要检查均已通过，排除项会继续记录在发布清单中。')}
        </p>
        <Card className="mt-5 border border-border bg-card ring-0">
          <CardContent className="pt-0">
            <div className="flex items-end justify-between border-b border-border pb-4">
              <div>
                <p className="text-xs text-muted-foreground">{t('Baseline quality', '基线质量')}</p>
                <p className="mt-1 font-mono text-2xl font-semibold">
                  {execution.baseline_profile.overall_score}
                </p>
              </div>
              <ArrowRight aria-hidden="true" className="mb-2 text-muted-foreground" />
              <div className="text-right">
                <p className="text-xs text-muted-foreground">{t('Candidate quality', '候选版本质量')}</p>
                <p className="mt-1 font-mono text-3xl font-semibold text-policy">
                  {execution.candidate_profile.overall_score}
                </p>
              </div>
            </div>
            <p className="mt-4 text-sm text-muted-foreground">
              {t(
                `Completeness stayed ${execution.candidate_profile.metrics[0].score}; no diagnosis code was imputed.`,
                `完整性保持 ${execution.candidate_profile.metrics[0].score}；系统没有填补任何诊断代码。`,
              )}
            </p>
          </CardContent>
        </Card>
        <div className="mt-4 grid grid-cols-3 gap-2">
          {[
            [t('Eligible', '可发布'), manifest.eligible_record_count],
            [t('Quarantined', '已隔离'), manifest.quarantined_record_uids.length],
            [t('Excluded', '已排除'), manifest.excluded_record_uids.length],
          ].map(([label, value]) => (
            <div key={label} className="rounded-xl bg-card p-3 text-center ring-1 ring-border">
              <p className="font-mono text-lg font-semibold">{Number(value).toLocaleString()}</p>
              <p className="text-[10px] text-muted-foreground">{label}</p>
            </div>
          ))}
        </div>
        <Card className="mt-4 border border-border bg-card ring-0">
          <CardHeader>
            <CardTitle className="flex items-center justify-between text-base">
              {t('Validation gate', '验证门禁')}
              <span className="font-mono text-sm text-policy">
                {manifest.validation_summary.passed}/{execution.validations.length}
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {execution.validations.slice(0, 5).map((validation) => (
              <div key={validation.check_id} className="flex items-center gap-2 text-sm">
                <CheckCircle2 aria-hidden="true" className="size-4 shrink-0 text-policy" />
                <span>{validation.message}</span>
              </div>
            ))}
          </CardContent>
        </Card>
        <div className="mt-4 rounded-xl border border-border bg-card p-4 font-mono text-[10px] text-muted-foreground">
          {t('Release', '发布版本')} {shortHash(manifest.release_artifact_hash)} · {t('Candidate', '候选版本')}{' '}
          {shortHash(manifest.candidate_artifact_hash)}
        </div>
        <Button
          variant="outline"
          size="lg"
          className="mt-5 min-h-12 w-full rounded-[14px]"
          onClick={() => {
            setStage('start');
            setRuleApproved(false);
            setResolvedRisks(new Set());
            window.sessionStorage.removeItem(STORAGE_KEY);
          }}
        >
          <RotateCcw data-icon="inline-start" aria-hidden="true" />
          {t('Restart verified demo', '重新开始演示')}
        </Button>
        <div className="mt-3 grid grid-cols-2 gap-2">
          <a
            href="/demo/cleaned.csv"
            download
            className="flex min-h-11 items-center justify-center rounded-xl border border-border bg-card px-3 text-center text-sm font-semibold text-primary hover:bg-muted"
          >
            {t('Cleaned CSV', '清洗后 CSV')}
          </a>
          <a
            href="/demo/release-report.json"
            download
            className="flex min-h-11 items-center justify-center rounded-xl border border-border bg-card px-3 text-center text-sm font-semibold text-primary hover:bg-muted"
          >
            {t('Audit report', '审计报告')}
          </a>
        </div>
      </section>
    </Shell>
  );
}
