'use client';

import { Database, History, LayoutDashboard, ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

import { StatusStrip } from '@/components/datapilot/status-strip';
import { LanguageToggle } from '@/components/language-toggle';
import { useLanguage } from '@/lib/language';
import { cn } from '@/lib/utils';

type NavItem = {
  href: string;
  en: string;
  zh: string;
  Icon: typeof LayoutDashboard;
  match: string;
  mobile?: boolean;
};

const NAV: NavItem[] = [
  { href: '/demo', en: 'Demo', zh: '演示', Icon: LayoutDashboard, match: '/demo', mobile: true },
  { href: '/workbench', en: 'Analyse', zh: '分析', Icon: Database, match: '/workbench', mobile: true },
  { href: '/runs', en: 'Runs', zh: '运行', Icon: History, match: '/runs' },
];

function isActive(item: NavItem, pathname: string): boolean {
  return pathname === item.match || pathname.startsWith(`${item.match}/`);
}

export type AppShellProps = {
  children: ReactNode;
};

/** A quiet product header. Operational telemetry appears only inside live-analysis routes. */
export function AppShell({ children }: AppShellProps) {
  const pathname = usePathname() ?? '/';
  const { t } = useLanguage();
  const showStatus =
    pathname === '/workbench' || pathname === '/runs' || pathname.startsWith('/runs/') || pathname === '/engine';

  return (
    <div className="min-h-dvh bg-background">
      <header className="sticky top-0 z-40 h-(--shell-header-height) border-b border-black/8 bg-white/95 backdrop-blur">
        <div className="mx-auto flex h-full w-full max-w-7xl items-center gap-3 px-4 sm:px-6 lg:px-8">
          <Link
            href="/"
            className="flex min-h-11 shrink-0 items-center gap-2"
            aria-label={t('DataPilot home', 'DataPilot 首页')}
          >
            <span className="grid size-7 place-items-center rounded-lg bg-ink text-white">
              <ShieldCheck aria-hidden="true" className="size-4" />
            </span>
            <span className="text-sm font-semibold tracking-[-0.02em] text-ink">DataPilot</span>
          </Link>

          <nav aria-label={t('Primary navigation', '主导航')} className="ml-auto flex min-w-0 items-center">
            <ul className="flex items-center gap-0.5">
              {NAV.map((item) => {
                const active = isActive(item, pathname);
                return (
                  <li key={item.href} className={cn(!item.mobile && 'hidden sm:block')}>
                    <Link
                      href={item.href}
                      aria-current={active ? 'page' : undefined}
                      className={cn(
                        'inline-flex min-h-11 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium transition-colors sm:px-3',
                        active
                          ? 'bg-policy-tint text-policy'
                          : 'text-muted-foreground hover:bg-muted/70 hover:text-foreground',
                      )}
                    >
                      <item.Icon aria-hidden="true" className="hidden size-3.5 sm:block" />
                      {t(item.en, item.zh)}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </nav>

          <LanguageToggle className="h-9 min-h-9 shrink-0 border-0 bg-transparent px-2 hover:bg-muted/70" />
        </div>
      </header>

      {showStatus ? <StatusStrip className="sticky top-(--shell-header-height) z-30" /> : null}

      <main id="content" className="min-w-0">
        {children}
      </main>
    </div>
  );
}
