'use client';

import { useParams } from 'next/navigation';

import { RunWorkspace } from './run-workspace';
import { EmptyState } from '@/components/datapilot';
import { useLanguage } from '@/lib/language';

export default function RunPage() {
  const params = useParams<{ id: string }>();
  const { t } = useLanguage();
  const runId = params?.id;
  if (!runId) {
    return (
      <div className="p-4">
        <EmptyState title={t('No run id in the URL', 'URL 中缺少运行 ID')} />
      </div>
    );
  }
  return <RunWorkspace runId={runId} />;
}
