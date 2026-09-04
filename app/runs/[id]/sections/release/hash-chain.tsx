'use client';

import { useLanguage } from '@/lib/language';
import type { DryRunReport, ReleaseManifest } from '@/lib/types';
import { cn } from '@/lib/utils';

import { EqHash } from './hash-equality';

export type HashChainLink = { key: string; zh: string; en: string; value: string | null };

/** source → contract → action set → decisions → candidate → release → change ledger (spec §9.2). */
export function chainLinks(manifest: ReleaseManifest, dryRun: DryRunReport | null): HashChainLink[] {
  return [
    { key: 'source', zh: '源文件', en: 'Source', value: manifest.source_artifact_hash },
    { key: 'contract', zh: '契约', en: 'Contract', value: manifest.contract_hash },
    { key: 'actions', zh: '动作集', en: 'Action set', value: dryRun?.approved_action_set_hash ?? null },
    { key: 'decisions', zh: '处置', en: 'Decisions', value: manifest.decision_set_hash || dryRun?.decision_set_hash || null },
    { key: 'candidate', zh: '候选文件', en: 'Candidate', value: manifest.candidate_artifact_hash },
    { key: 'release', zh: '发布文件', en: 'Release', value: manifest.release_artifact_hash },
    { key: 'ledger', zh: '变更账本', en: 'Change ledger', value: manifest.change_ledger_hash },
  ];
}

export function HashChain({ manifest, dryRun, className }: { manifest: ReleaseManifest; dryRun: DryRunReport | null; className?: string }) {
  const { t, language } = useLanguage();
  const links = chainLinks(manifest, dryRun);
  return (
    <ol className={cn('flex flex-wrap items-end gap-x-1 gap-y-2', className)} aria-label={t('Hash chain', '哈希链')}>
      {links.map((link, index) => (
        <li key={link.key} className="flex items-end gap-1">
          <span className="flex flex-col gap-0.5">
            <span className="text-[11px] text-muted-foreground">{language === 'zh' ? link.zh : link.en}</span>
            <EqHash value={link.value} length={12} />
          </span>
          {index < links.length - 1 ? (
            <span aria-hidden="true" className="mono pb-1 text-muted-foreground">
              →
            </span>
          ) : null}
        </li>
      ))}
    </ol>
  );
}
