'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

import { useLanguage } from '@/lib/language';

/** `/runs/new` is retired; the upload form lives on the workbench at `/`. */
export default function NewRunRedirect() {
  const router = useRouter();
  const { t } = useLanguage();

  useEffect(() => {
    router.replace('/');
  }, [router]);

  return (
    <div className="px-4 py-6 text-[13px] text-muted-foreground">
      {t('Redirecting to the workbench.', '正在跳转到工作台。')}{' '}
      <Link href="/" className="text-policy underline-offset-2 hover:underline">
        {t('Open it directly', '直接打开')}
      </Link>
    </div>
  );
}
