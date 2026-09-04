'use client';

import { Cpu, Database, History, LayoutGrid, PlayCircle, ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

import { StatusStrip } from '@/components/datapilot/status-strip';
import { useLanguage } from '@/lib/language';
import { cn } from '@/lib/utils';

type NavItem = {
  href: string;
  en: string;
  zh: string;
  Icon: typeof LayoutGrid;
  /** Pathname prefix that marks the item active; `null` means never (hash links). */
  match: string | null;
  exact?: boolean;
};

const NAV: NavItem[] = [
  { href: '/', en: 'Workbench', zh: '工作台', Icon: LayoutGrid, match: '/', exact: true },
  { href: '/runs', en: 'Runs', zh: '运行记录', Icon: History, match: '/runs' },
  { href: '/#samples', en: 'Samples', zh: '样例数据', Icon: Database, match: null },
  { href: '/engine', en: 'Engine', zh: '关于引擎', Icon: Cpu, match: '/engine' },
  { href: '/demo/clinical-nlp', en: 'Offline replay', zh: '离线回放', Icon: PlayCircle, match: '/demo' },
];

function isActive(item: NavItem, pathname: string): boolean {
  if (item.match === null) return false;
  if (item.exact) return pathname === item.match;
  return pathname === item.match || pathname.startsWith(`${item.match}/`);
}

export type AppShellProps = {
  children: ReactNode;
};

/**
 * Application frame: left sidebar (≥ 768px) or top bar (< 768px), status strip, and content.
 * Pages render inside `<main id="content">`.
 */
export function AppShell({ children }: AppShellProps) {
  const pathname = usePathname() ?? '/';
  const { t } = useLanguage();

  const nav = (orientation: 'vertical' | 'horizontal') => (
    <nav aria-label={t('Primary', '主导航')} className={cn(orientation === 'horizontal' && 'min-w-0 overflow-x-auto')}>
      <ul className={cn('flex gap-0.5', orientation === 'vertical' ? 'flex-col px-2' : 'flex-row items-center px-1')}>
        {NAV.map((item) => {
          const active = isActive(item, pathname);
          return (
            <li key={item.href} className="shrink-0">
              <Link
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex items-center gap-2 rounded-md px-2 text-[13px] font-medium transition-colors',
                  orientation === 'vertical' ? 'h-8' : 'h-11 whitespace-nowrap',
                  active ? 'bg-policy-tint text-policy' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                )}
              >
                <item.Icon aria-hidden="true" className="size-4 shrink-0" />
                <span>{t(item.en, item.zh)}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );

  return (
    <div className="flex min-h-dvh flex-col bg-background md:flex-row">
      {/* Sidebar (≥ md) */}
      <aside className="sticky top-0 hidden h-dvh w-(--shell-sidebar-width) shrink-0 flex-col border-r border-border bg-card md:flex">
        <Link href="/" className="flex h-(--shell-strip-height) items-center gap-2 border-b border-border px-3">
          <span className="grid size-6 place-items-center rounded-md bg-primary text-primary-foreground">
            <ShieldCheck aria-hidden="true" className="size-3.5" />
          </span>
          <span className="text-[13px] font-semibold tracking-tight">DataPilot</span>
          <span className="ml-auto mono text-[10px] text-muted-foreground">v0.2</span>
        </Link>
        <div className="py-2">{nav('vertical')}</div>
        <div className="mt-auto border-t border-border px-3 py-2 text-[11px] leading-4 text-muted-foreground">
          {t('AI proposes · Policy decides · Humans decide high-risk · Rules execute · Validations gate release',
            'AI 提议 · 策略决策 · 高风险由人决定 · 规则执行 · 验证把关')}
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Top bar (< md) */}
        <header className="flex h-(--shell-strip-height) items-center gap-2 border-b border-border bg-card px-2 md:hidden">
          <Link href="/" className="flex shrink-0 items-center gap-2 pr-1">
            <span className="grid size-6 place-items-center rounded-md bg-primary text-primary-foreground">
              <ShieldCheck aria-hidden="true" className="size-3.5" />
            </span>
            <span className="text-[13px] font-semibold tracking-tight">DataPilot</span>
          </Link>
          {nav('horizontal')}
        </header>

        <StatusStrip className="sticky top-0 z-20" />

        <main id="content" className="min-w-0 flex-1">
          {children}
        </main>
      </div>
    </div>
  );
}
