'use client';

import {
  ArrowRight,
  CheckCircle2,
  FileSpreadsheet,
  LockKeyhole,
  ShieldCheck,
} from 'lucide-react';
import Link from 'next/link';

import { LanguageToggle } from '@/components/language-toggle';
import { Badge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { useLanguage } from '@/lib/language';
import { useLiveApiAvailable } from '@/lib/live-api';

export default function Home() {
  const { t } = useLanguage();
  const liveApiAvailable = useLiveApiAvailable();
  const checks = [
    [t('Profile structure', '分析数据结构'), t('18 fields', '18 个字段')],
    [t('Evaluate release policy', '执行发布策略'), t('7 checks', '7 项检查')],
    [t('Protect sensitive values', '保护敏感值'), t('Before AI', '先于 AI')],
  ] as const;
  return (
    <main className="min-h-dvh bg-background text-foreground">
      <header className="border-b border-border/90 bg-card/95">
        <div className="mx-auto flex min-h-16 w-full max-w-6xl items-center justify-between px-4 sm:px-6">
          <div className="flex items-center gap-3">
            <span className="grid size-9 place-items-center rounded-xl bg-primary text-primary-foreground">
              <ShieldCheck aria-hidden="true" className="size-5" />
            </span>
            <div>
              <p className="text-[15px] font-semibold leading-tight">DataPilot</p>
              <p className="text-xs text-muted-foreground">{t('Dataset release desk', '数据发布工作台')}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Badge className="hidden bg-policy-tint text-policy ring-1 ring-policy/15 sm:inline-flex">
              {t('Explainable by design', '全程可解释')}
            </Badge>
            <LanguageToggle />
          </div>
        </div>
      </header>

      <div className="mx-auto grid w-full max-w-6xl gap-6 px-4 py-6 sm:px-6 sm:py-8 lg:grid-cols-[minmax(0,1fr)_360px] lg:items-start">
        <section aria-labelledby="page-title" className="min-w-0">
          <div className="mb-5 max-w-2xl">
            <p className="mb-2 font-mono text-xs font-semibold uppercase tracking-[0.14em] text-primary">
              {t('New release assessment', '新建发布评估')}
            </p>
            <h1
              id="page-title"
              className="text-balance text-[clamp(1.65rem,4.8vw,2.35rem)] font-semibold leading-tight tracking-[-0.03em]"
            >
              {t('Can this dataset ship today?', '这份数据今天能发布吗？')}
            </h1>
            <p className="mt-2 max-w-xl text-sm leading-6 text-muted-foreground sm:text-base">
              {t(
                'Turn quality findings into reviewable, executable, and auditable release decisions.',
                '把数据质量问题转化为可审查、可执行、可追溯的发布决策。',
              )}
            </p>
          </div>

          <Card className="border border-border bg-card shadow-[0_16px_50px_rgb(16_35_30/6%)] ring-0">
            <CardHeader className="border-b border-border/80 pb-4">
              <div className="mb-3 flex size-11 items-center justify-center rounded-[14px] bg-policy-tint text-policy">
                <FileSpreadsheet aria-hidden="true" className="size-5" />
              </div>
              <CardTitle className="text-xl">{t('Analyze a CSV release candidate', '分析 CSV 发布候选')}</CardTitle>
              <CardDescription className="max-w-lg leading-6">
                {t(
                  'Upload a UTF-8 CSV up to 25 MiB. The source stays unchanged while DataPilot profiles, checks, and prepares a governed change set.',
                  '上传不超过 25 MiB 的 UTF-8 CSV。DataPilot 会在保持源文件不变的前提下完成画像、检查并生成受控变更集。',
                )}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4 pt-1">
              <Link
                href={liveApiAvailable ? '/runs/new' : '/demo/clinical-nlp'}
                className="flex min-h-28 w-full items-center justify-between gap-4 rounded-[16px] border border-dashed border-border bg-muted/45 px-4 text-left transition-colors hover:border-primary/45 hover:bg-policy-tint/50 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/40"
              >
                <span>
                  <span className="block text-base font-semibold">
                    {liveApiAvailable
                      ? t('Choose a CSV file', '选择 CSV 文件')
                      : t('Open verified replay', '打开已验证演示回放')}
                  </span>
                  <span className="mt-1 block text-sm text-muted-foreground">
                    {liveApiAvailable
                      ? t('Nothing is changed without a reviewable action.', '未经可审查的动作授权，不会修改任何数据。')
                      : t('The published preview does not claim a live engine connection.', '当前发布预览未连接实时引擎，不会伪装为在线分析。')}
                  </span>
                </span>
                <ArrowRight aria-hidden="true" className="size-5 shrink-0 text-primary" />
              </Link>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <LockKeyhole aria-hidden="true" className="size-3.5" />
                {t('Sensitive values are screened before semantic analysis.', '敏感值会在语义分析前完成筛查。')}
              </div>
            </CardContent>
          </Card>
        </section>

        <aside aria-label="Verified demonstration" className="lg:sticky lg:top-6">
          <Card className="border border-border bg-ink text-white ring-0">
            <CardHeader>
              <Badge className="mb-3 bg-white/10 text-white ring-1 ring-white/15">
                {t('Verified demo replay', '已验证演示回放')}
              </Badge>
              <CardTitle className="text-xl text-white">{t('Clinical NLP release candidate', '临床 NLP 发布候选')}</CardTitle>
              <CardDescription className="leading-6 text-white/65">
                {t(
                  'A deterministic, synthetic scenario built for a reliable offline walkthrough.',
                  '基于确定性合成数据构建，可稳定离线演示完整流程。',
                )}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <dl className="divide-y divide-white/10 border-y border-white/10">
                {checks.map(([label, value]) => (
                  <div key={label} className="flex items-center justify-between gap-4 py-3.5">
                    <dt className="flex items-center gap-2 text-sm text-white/70">
                      <CheckCircle2 aria-hidden="true" className="size-4 text-[#7dd8c5]" />
                      {label}
                    </dt>
                    <dd className="font-mono text-xs font-semibold text-white">{value}</dd>
                  </div>
                ))}
              </dl>
              <Link
                href="/demo/clinical-nlp"
                className={buttonVariants({
                  size: 'lg',
                  className:
                    'mt-5 min-h-12 w-full rounded-[14px] bg-white text-ink hover:bg-white/90',
                })}
              >
                {t('Try verified demo', '体验已验证演示')}
                <ArrowRight data-icon="inline-end" aria-hidden="true" />
              </Link>
              <p className="mt-3 text-center text-xs text-white/55">
                {t('Synthetic data · No live model required', '合成数据 · 无需实时模型')}
              </p>
            </CardContent>
          </Card>
        </aside>
      </div>

      <footer className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-5 text-xs text-muted-foreground sm:px-6">
        <span>{t('AI proposes · Policy decides · Rules execute', 'AI 提议 · 策略决策 · 规则执行')}</span>
        <span>{t('Source artifacts remain immutable', '源数据始终不可变')}</span>
      </footer>
    </main>
  );
}
