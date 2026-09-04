'use client';

import {
  ArrowRight,
  Bot,
  CheckCircle2,
  Database,
  FileCheck2,
  LockKeyhole,
  ScanSearch,
  ShieldCheck,
} from 'lucide-react';
import Link from 'next/link';

import { buttonVariants } from '@/components/ui/button';
import { boothDemo } from '@/lib/booth-demo';
import { formatBytes, formatInt, shortHash } from '@/lib/format';
import { useLanguage } from '@/lib/language';
import { cn } from '@/lib/utils';

function Metric({ value, label }: { value: string; label: string }) {
  return (
    <div className="min-w-0">
      <div className="mono text-xl font-semibold tracking-[-0.04em] text-ink sm:text-2xl">{value}</div>
      <div className="mt-1 text-xs leading-4 text-muted-foreground">{label}</div>
    </div>
  );
}

export default function HomePage() {
  const { t } = useLanguage();
  const demo = boothDemo;
  const blockingCount = demo.findings.filter((finding) => finding.blocking).length;

  return (
    <div className="min-h-[calc(100dvh-var(--shell-header-height))] bg-[linear-gradient(180deg,#f7f8f5_0%,#eef3f1_72%)]">
      <div className="mx-auto w-full max-w-6xl px-5 pt-10 pb-16 sm:px-8 sm:pt-16 lg:px-10 lg:pt-20">
        <section className="grid items-center gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(430px,0.9fr)] lg:gap-16">
          <div>
            <div className="mb-5 flex flex-wrap items-center gap-2 text-xs font-medium text-muted-foreground">
              <span className="inline-flex items-center gap-1.5 rounded-full border border-policy/20 bg-policy-tint px-3 py-1.5 text-policy">
                <ShieldCheck aria-hidden="true" className="size-3.5" />
                {t('Release-ready data, with proof', '数据能否交付，一眼看清')}
              </span>
              <span>{t('For analysts and AI teams', '为分析与 AI 团队打造')}</span>
            </div>

            <h1 className="max-w-2xl text-3xl leading-[1.08] font-semibold tracking-[-0.045em] text-ink sm:text-4xl lg:text-[46px]">
              {t('Turn a messy CSV into a decision you can defend.', '把混乱的 CSV，变成有依据的发布决定。')}
            </h1>
            <p className="mt-5 max-w-xl text-[15px] leading-7 text-muted-foreground sm:text-base">
              {t(
                'DataPilot finds what could break downstream work, asks AI only where meaning is unclear, and shows exactly what is safe to share.',
                'DataPilot 找出会影响下游使用的问题，只在语义不清时请 AI 协助，并明确告诉你哪些数据可以放心交付。',
              )}
            </p>

            <div className="mt-7 flex flex-col gap-3 sm:flex-row">
              <Link
                href="/demo"
                className={cn(buttonVariants({ size: 'lg' }), 'h-11 justify-between gap-5 rounded-xl px-4 sm:justify-center')}
              >
                <span>{t('Watch the 3-minute demo', '看 3 分钟演示')}</span>
                <ArrowRight aria-hidden="true" />
              </Link>
              <Link
                href="/workbench"
                className={cn(buttonVariants({ variant: 'outline', size: 'lg' }), 'h-11 rounded-xl bg-white px-4')}
              >
                {t('Analyse your CSV', '分析自己的 CSV')}
              </Link>
            </div>

            <div className="mt-6 flex flex-wrap gap-x-5 gap-y-2 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1.5">
                <CheckCircle2 aria-hidden="true" className="size-3.5 text-policy" />
                {t('No sign-in', '无需登录')}
              </span>
              <span className="inline-flex items-center gap-1.5">
                <CheckCircle2 aria-hidden="true" className="size-3.5 text-policy" />
                {t('Starts instantly', '即开即看')}
              </span>
              <span className="inline-flex items-center gap-1.5">
                <CheckCircle2 aria-hidden="true" className="size-3.5 text-policy" />
                {t('Chinese and English', '中英双语')}</span>
            </div>
          </div>

          <div className="overflow-hidden rounded-2xl border border-black/8 bg-white shadow-[0_24px_80px_rgba(16,35,30,0.08)]">
            <div className="flex items-start justify-between gap-4 border-b border-black/7 px-5 py-4 sm:px-6">
              <div>
                <div className="text-xs font-medium tracking-wide text-policy uppercase">
                  {t('Checked example', '真实案例')}
                </div>
                <h2 className="mt-1 text-base font-semibold text-ink">
                  {t(demo.source.title_en, demo.source.title_zh)}
                </h2>
              </div>
              <span className="shrink-0 rounded-full bg-review-tint px-2.5 py-1 text-[11px] font-semibold text-review">
                {t('Conditional pass', '有条件通过')}
              </span>
            </div>

            <div className="px-5 py-5 sm:px-6">
              <div className="flex items-end justify-between gap-5">
                <div>
                  <div className="text-xs text-muted-foreground">{t('Data quality', '数据质量')}</div>
                  <div className="mt-1 flex items-baseline gap-2">
                    <span className="mono text-4xl font-semibold tracking-[-0.06em] text-ink">
                      {demo.quality.baseline.overall_score.toFixed(2)}
                    </span>
                    <span className="text-sm text-muted-foreground">/ 100</span>
                  </div>
                </div>
                <div className="text-right text-xs leading-5 text-muted-foreground">
                  <div>{formatInt(demo.source.record_count)} {t('records', '条记录')}</div>
                  <div>{formatInt(demo.source.column_count)} {t('columns', '个字段')} · {formatBytes(demo.source.bytes)}</div>
                </div>
              </div>

              <div className="mt-5 grid grid-cols-3 gap-4 border-y border-black/7 py-4">
                <Metric value={formatInt(demo.findings.length)} label={t('issues found', '项问题')} />
                <Metric value={formatInt(blockingCount)} label={t('need action', '项需处理')} />
                <Metric
                  value={`${formatInt(demo.release.validation_summary.passed)}/${formatInt(
                    demo.release.validation_summary.passed + demo.release.validation_summary.failed,
                  )}`}
                  label={t('checks passed', '项检查通过')}
                />
              </div>

              <div className="mt-4 flex items-center justify-between gap-4 text-xs text-muted-foreground">
                <span className="inline-flex items-center gap-1.5">
                  <Database aria-hidden="true" className="size-3.5" />
                  {t('Real public data · CC BY 4.0', '真实公开数据 · CC BY 4.0')}
                </span>
                <span className="mono" title={demo.source.sha256}>sha256 {shortHash(demo.source.sha256, 8)}</span>
              </div>
            </div>
          </div>
        </section>

        <section className="mt-16 border-t border-black/10 pt-8 sm:mt-20">
          <div className="grid gap-8 md:grid-cols-3 md:gap-0">
            {[
              {
                icon: ScanSearch,
                title: t('See the real problems', '先看清真实问题'),
                body: t(
                  'Spot missing values, duplicates and risky formats before they reach downstream work.',
                  '在数据进入下游前，找出缺失、重复和高风险格式。',
                ),
              },
              {
                icon: Bot,
                title: t('Use AI where it helps', '只在需要时使用 AI'),
                body: t(
                  'AI helps interpret unclear values, while evidence and people remain in control.',
                  'AI 帮你理解模糊取值，证据与人始终掌握最终决定。',
                ),
              },
              {
                icon: FileCheck2,
                title: t('Share with confidence', '带着依据交付'),
                body: t(
                  'Every change, exclusion and check is recorded in one reviewable release package.',
                  '每次修改、隔离和检查都记录在一份可复核的交付包里。',
                ),
              },
            ].map((item, index) => (
              <div
                key={item.title}
                className={cn('flex gap-4 md:px-7', index === 0 && 'md:pl-0', index > 0 && 'md:border-l md:border-black/10')}
              >
                <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-white text-policy shadow-[0_4px_18px_rgba(16,35,30,0.06)]">
                  <item.icon aria-hidden="true" className="size-4" />
                </span>
                <div>
                  <h3 className="text-sm font-semibold text-ink">{item.title}</h3>
                  <p className="mt-1.5 text-[13px] leading-5 text-muted-foreground">{item.body}</p>
                </div>
              </div>
            ))}
          </div>
        </section>

        <footer className="mt-14 flex flex-col gap-3 border-t border-black/10 pt-5 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          <span className="inline-flex items-center gap-1.5">
            <LockKeyhole aria-hidden="true" className="size-3.5" />
            {t('This example contains summary results only—never the source rows.', '这个案例只展示汇总结果，不包含任何源数据行。')}
          </span>
          <Link href="/runs" className="font-medium text-foreground underline-offset-4 hover:underline">
            {t('View analysis history', '查看分析记录')} →
          </Link>
        </footer>
      </div>
    </div>
  );
}
