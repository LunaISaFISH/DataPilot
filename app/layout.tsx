import type { Metadata } from 'next';

import './globals.css';

export const metadata: Metadata = {
  title: 'DataPilot — Dataset Release Desk',
  description: 'Explainable, reviewable dataset quality and release decisions.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
