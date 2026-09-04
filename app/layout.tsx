import type { Metadata } from 'next';

import './globals.css';
import { AppShell } from '@/components/datapilot/app-shell';
import { LanguageProvider } from '@/lib/language';

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000'),
  title: 'DataPilot — Dataset Release Desk',
  description: 'Explainable, reviewable dataset quality and release decisions.',
  manifest: '/manifest.webmanifest',
  icons: { icon: '/favicon.svg' },
  openGraph: {
    title: 'DataPilot — Dataset Release Desk',
    description: 'Explainable, reviewable dataset quality and release decisions.',
    images: [{ url: '/og.png', width: 1200, height: 630, alt: 'DataPilot release dashboard' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'DataPilot — Dataset Release Desk',
    description: 'Explainable, reviewable dataset quality and release decisions.',
    images: ['/og.png'],
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>
        <LanguageProvider>
          <AppShell>{children}</AppShell>
        </LanguageProvider>
      </body>
    </html>
  );
}
