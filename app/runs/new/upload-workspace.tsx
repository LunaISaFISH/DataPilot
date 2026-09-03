'use client';

import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  FileSpreadsheet,
  LoaderCircle,
  ShieldCheck,
} from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';

import { LanguageToggle } from '@/components/language-toggle';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatLabel, type RunReport } from '@/lib/datapilot';
import { useLanguage } from '@/lib/language';

type CreatedRun = { run_id: string; report: RunReport };
type UploadState = 'idle' | 'loading' | 'success' | 'error';

const apiBase = process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:8000';
const zhFindingTitles: Record<string, string> = {
  'DUP-001': '可从发布版本排除完全重复的导入记录',
  'CAT-002': '地区别名可规范化',
  'FMT-003': '就诊日期存在另一种无歧义格式',
  'SEM-004': '诊断标签变体可归并为规范术语',
  'SEM-004-CONFLICT': '代码冲突阻止语义规范化',
  'AMB-005': '多义缩写需要人工审查',
  'MISS-006': '必填诊断代码缺失',
  'PHI-007': '潜在直接标识符需要发布隔离',
};

export function UploadWorkspace() {
  const { language, t } = useLanguage();
  const [csv, setCsv] = useState<File | null>(null);
  const [policy, setPolicy] = useState<File | null>(null);
  const [state, setState] = useState<UploadState>('idle');
  const [result, setResult] = useState<CreatedRun | null>(null);
  const [error, setError] = useState('');

  async function analyze() {
    if (!csv) return;
    setState('loading');
    setError('');
    const form = new FormData();
    form.append('file', csv);
    if (policy) form.append('policy', policy);
    try {
      const response = await fetch(`${apiBase}/v1/runs`, { method: 'POST', body: form });
      if (!response.ok) {
        const body = (await response.json()) as { detail?: string | { message?: string } };
        const message =
          typeof body.detail === 'string'
            ? body.detail
            : body.detail?.message || t('Analysis failed.', '分析失败。');
        throw new Error(message);
      }
      setResult((await response.json()) as CreatedRun);
      setState('success');
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : t('The protected analysis service could not be reached.', '无法连接受保护的分析服务。'),
      );
      setState('error');
    }
  }

  return (
    <main className="min-h-dvh bg-background pb-[calc(24px+env(safe-area-inset-bottom))]">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex min-h-16 max-w-3xl items-center justify-between px-4">
          <div className="flex items-center gap-2">
            <Link
              href="/"
              aria-label={t('Back to DataPilot', '返回 DataPilot')}
              className={buttonVariants({
                variant: 'ghost',
                size: 'icon',
                className: 'size-11',
              })}
            >
              <ArrowLeft aria-hidden="true" />
              <span className="sr-only">{t('Back to DataPilot', '返回 DataPilot')}</span>
            </Link>
            <div>
              <p className="text-sm font-semibold">{t('New analysis', '新建分析')}</p>
              <p className="text-[11px] text-muted-foreground">{t('Protected live engine', '受保护的实时引擎')}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Badge className="hidden bg-policy-tint text-policy ring-1 ring-policy/15 sm:inline-flex">Polars {t('engine', '引擎')}</Badge>
            <LanguageToggle />
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-3xl px-4 py-6">
        {state !== 'success' || !result ? (
          <section>
            <div className="mb-6">
              <p className="font-mono text-xs font-semibold uppercase tracking-[0.14em] text-primary">
                {t('Source immutable', '源数据不可变')}
              </p>
              <h1 className="mt-2 text-2xl font-semibold tracking-[-0.025em]">
                {t('Analyze your CSV', '分析你的 CSV')}
              </h1>
              <p className="mt-2 max-w-xl text-sm leading-6 text-muted-foreground">
                {t(
                  'Without a Data Contract, DataPilot returns objective observations only and will not invent required fields, business keys, or semantic mappings.',
                  '未提供数据契约时，DataPilot 只返回客观观测结果，不会猜测必填字段、业务键或语义映射。',
                )}
              </p>
            </div>

            <Card className="border border-border bg-card ring-0">
              <CardHeader>
                <div className="grid size-11 place-items-center rounded-[14px] bg-policy-tint text-policy">
                  <FileSpreadsheet aria-hidden="true" />
                </div>
                <CardTitle className="mt-2 text-lg">{t('Release candidate', '发布候选')}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-5">
                <div>
                  <label htmlFor="csv-file" className="mb-2 block text-sm font-semibold">
                    CSV {t('file', '文件')} <span className="text-blocker">*</span>
                  </label>
                  <input
                    id="csv-file"
                    type="file"
                    accept=".csv,text/csv"
                    className="min-h-12 w-full rounded-lg border border-input bg-transparent px-2.5 py-2 text-base outline-none file:mr-3 file:border-0 file:bg-transparent file:text-sm file:font-medium focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                    onChange={(event) => setCsv(event.target.files?.[0] ?? null)}
                  />
                  <p className="mt-2 text-xs text-muted-foreground">
                    UTF-8 · {t('up to 25 MiB', '最大 25 MiB')} · {t('250,000 records', '250,000 条记录')}
                  </p>
                </div>
                <div>
                  <label htmlFor="policy-file" className="mb-2 block text-sm font-semibold">
                    {t('Data Contract', '数据契约')} <span className="font-normal text-muted-foreground">{t('(optional)', '（可选）')}</span>
                  </label>
                  <input
                    id="policy-file"
                    type="file"
                    accept=".yaml,.yml,application/yaml"
                    className="min-h-12 w-full rounded-lg border border-input bg-transparent px-2.5 py-2 text-base outline-none file:mr-3 file:border-0 file:bg-transparent file:text-sm file:font-medium focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                    onChange={(event) => setPolicy(event.target.files?.[0] ?? null)}
                  />
                  <p className="mt-2 text-xs text-muted-foreground">
                    {t('Strict declarative YAML · up to 64 KiB', '严格声明式 YAML · 最大 64 KiB')}
                  </p>
                </div>
                {state === 'error' ? (
                  <div role="alert" className="flex gap-3 rounded-xl bg-[#fbe9e7] p-3 text-sm text-blocker">
                    <AlertCircle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                    <span>{error}</span>
                  </div>
                ) : null}
                <Button
                  size="lg"
                  disabled={!csv || state === 'loading'}
                  className="min-h-12 w-full rounded-[14px]"
                  onClick={analyze}
                >
                  {state === 'loading' ? (
                    <>
                      <LoaderCircle data-icon="inline-start" className="animate-spin" />
                      {t('Running deterministic checks', '正在执行确定性检查')}
                    </>
                  ) : (
                    <>
                      {t('Analyze dataset', '分析数据集')}
                      <ArrowRight data-icon="inline-end" />
                    </>
                  )}
                </Button>
              </CardContent>
            </Card>

            <div className="mt-4 flex items-center gap-2 text-xs text-muted-foreground">
              <ShieldCheck aria-hidden="true" className="size-4 text-policy" />
              {t('Raw sensitive values are withheld from logs and semantic analysis.', '原始敏感值不会进入日志或语义分析。')}
            </div>
          </section>
        ) : (
          <section>
            <Badge
              className={
                result.report.release_status === 'NOT_EVALUATED'
                  ? 'bg-[#fff1d8] text-review ring-1 ring-review/15'
                  : 'bg-[#fbe9e7] text-blocker ring-1 ring-blocker/15'
              }
            >
              {language === 'zh'
                ? result.report.release_status === 'NOT_EVALUATED'
                  ? '尚未评估发布状态'
                  : result.report.release_status === 'BLOCKED'
                    ? '发布已阻断'
                    : result.report.release_status === 'CONDITIONAL_PASS'
                      ? '有条件通过'
                      : '通过'
                : formatLabel(result.report.release_status)}
            </Badge>
            <h1 className="mt-2 text-2xl font-semibold tracking-[-0.025em]">{t('Analysis complete', '分析完成')}</h1>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              {(result.report.warnings[0]
                ? t(result.report.warnings[0], '未提供数据契约；当前结果仅为客观观测，不判定发布资格。')
                : null) ||
                t(
                  'Findings are grounded in the supplied Data Contract and require disposition.',
                  '问题基于已提供的数据契约生成，需要逐项处置。',
                )}
            </p>
            <Card className="mt-5 border border-border bg-card ring-0">
              <CardContent className="grid grid-cols-3 gap-2 pt-0">
                {[
                  [t('Records', '记录'), result.report.profile.record_count],
                  [t('Fields', '字段'), result.report.profile.column_count],
                  [t('Findings', '问题'), result.report.findings.length],
                ].map(([label, value]) => (
                  <div key={label} className="text-center">
                    <p className="font-mono text-xl font-semibold">{Number(value).toLocaleString()}</p>
                    <p className="mt-1 text-[11px] text-muted-foreground">{label}</p>
                  </div>
                ))}
              </CardContent>
            </Card>
            <div className="mt-4 space-y-2">
              {result.report.findings.map((finding) => (
                <div key={finding.finding_id} className="rounded-xl border border-border bg-card p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold">{language === 'zh' ? (zhFindingTitles[finding.finding_id] ?? finding.title) : finding.title}</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {t(
                          `${finding.affected_record_count} records · ${finding.affected_cell_count} cells`,
                          `${finding.affected_record_count} 条记录 · ${finding.affected_cell_count} 个单元格`,
                        )}
                      </p>
                    </div>
                    <Badge variant="outline">
                      {language === 'zh'
                        ? finding.risk_level === 'HIGH'
                          ? '高风险'
                          : finding.risk_level === 'MEDIUM'
                            ? '中风险'
                            : '低风险'
                        : finding.risk_level}
                    </Badge>
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-5 rounded-xl bg-policy-tint p-4 text-sm text-policy">
              <div className="flex items-center gap-2 font-semibold">
                <CheckCircle2 aria-hidden="true" className="size-4" /> {t('Source artifact retained', '源数据工件已保留')}
              </div>
              <p className="mt-1 text-xs">{t('Run', '运行')} {result.run_id.slice(0, 10)} · {t('no changes applied', '未应用任何变更')}</p>
            </div>
            <Button
              variant="outline"
              size="lg"
              className="mt-5 min-h-12 w-full"
              onClick={() => {
                setState('idle');
                setResult(null);
                setCsv(null);
                setPolicy(null);
              }}
            >
              {t('Analyze another dataset', '分析另一份数据')}
            </Button>
          </section>
        )}
      </div>
    </main>
  );
}
