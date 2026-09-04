'use client';

import { KeyValueList, Pill, ReleaseStatusPill } from '@/components/datapilot';
import { formatInt } from '@/lib/format';
import { useLanguage } from '@/lib/language';
import { label } from '@/lib/labels';
import type { DryRunReport, ReleaseManifest } from '@/lib/types';

import { EqHash } from './hash-equality';
import { HashChain } from './hash-chain';

export type ManifestCardProps = {
  manifest: ReleaseManifest;
  dryRun: DryRunReport | null;
};

/** Release manifest: status, counts, excluded columns, AI usage, contract/policy hashes, hash chain. */
export function ManifestCard({ manifest, dryRun }: ManifestCardProps) {
  const { t, language } = useLanguage();
  const outcomeEntries = Object.entries(manifest.finding_outcome_counts);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <ReleaseStatusPill value={manifest.release_status} className="h-6 px-2.5 text-xs" />
        <span className="text-xs text-muted-foreground">
          {t('Validations', '验证')} <span className="mono text-foreground">{formatInt(manifest.validation_summary.passed)}</span> {t('passed', '通过')} ·{' '}
          <span className={manifest.validation_summary.failed > 0 ? 'mono text-blocker' : 'mono text-foreground'}>{formatInt(manifest.validation_summary.failed)}</span> {t('failed', '未通过')}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        {[
          { key: 'total', zh: '源记录', en: 'Source records', value: manifest.total_source_records },
          { key: 'eligible', zh: '可发布', en: 'Releasable', value: manifest.eligible_record_count },
          { key: 'quarantined', zh: '隔离', en: 'Quarantined', value: manifest.quarantined_record_uids.length },
          { key: 'excluded', zh: '排除', en: 'Excluded', value: manifest.excluded_record_uids.length },
          { key: 'flagged', zh: '标记', en: 'Flagged', value: manifest.flagged_record_uids.length },
        ].map((item) => (
          <div key={item.key} className="rounded-md border border-border px-2.5 py-1.5">
            <div className="text-[11px] text-muted-foreground">{language === 'zh' ? item.zh : item.en}</div>
            <div className="mono text-lg font-semibold leading-6">{formatInt(item.value)}</div>
          </div>
        ))}
      </div>

      <KeyValueList
        columns={2}
        items={[
          {
            key: 'excluded_columns',
            label: t('Excluded columns', '排除字段'),
            value:
              manifest.excluded_columns.length > 0 ? (
                <span className="inline-flex flex-wrap justify-end gap-1">
                  {manifest.excluded_columns.map((column) => (
                    <span key={column} className="pill pill-blocker mono font-normal">
                      {column}
                    </span>
                  ))}
                </span>
              ) : (
                <span className="text-muted-foreground">{t('none', '无')}</span>
              ),
          },
          {
            key: 'ai',
            label: t('AI calls / provider', 'AI 调用 / 提供方'),
            value: (
              <span className="inline-flex items-center gap-1.5">
                <span className="mono">{formatInt(manifest.ai_call_count)}</span>
                <Pill variant={manifest.ai_provider === 'anthropic' ? 'ai' : 'neutral'}>{label('provider', manifest.ai_provider, language)}</Pill>
              </span>
            ),
          },
          { key: 'contract_hash', label: t('Contract hash', '契约哈希'), value: <EqHash value={manifest.contract_hash} length={16} /> },
          { key: 'policy_pack_hash', label: t('Policy pack hash', '策略包哈希'), value: <EqHash value={manifest.policy_pack_hash} length={16} /> },
          { key: 'scope_hash', label: t('Scope hash', '评分范围哈希'), value: <EqHash value={manifest.scope_hash} length={16} /> },
          { key: 'versions', label: t('Engine / score version', '引擎 / 评分版本'), value: `${manifest.engine_version} / ${manifest.score_version}`, mono: true },
          ...(outcomeEntries.length > 0
            ? [
                {
                  key: 'outcomes',
                  label: t('Finding outcomes', '发现处置计数'),
                  value: (
                    <span className="mono text-xs">
                      {outcomeEntries.map(([outcome, count]) => `${label('disposition', outcome, language)} ${formatInt(count)}`).join(' · ')}
                    </span>
                  ),
                },
              ]
            : []),
          ...(Object.keys(manifest.ai_input_hashes).length > 0
            ? [
                {
                  key: 'ai_inputs',
                  label: t('AI input hashes', 'AI 输入哈希'),
                  value: (
                    <span className="inline-flex flex-wrap justify-end gap-1">
                      {Object.entries(manifest.ai_input_hashes).map(([findingId, hash]) => (
                        <EqHash key={findingId} label={findingId} value={hash} length={10} />
                      ))}
                    </span>
                  ),
                },
              ]
            : []),
        ]}
      />

      <div className="flex flex-col gap-1.5 border-t border-border pt-3">
        <span className="text-xs font-semibold text-muted-foreground">{t('Hash chain', '哈希链')}</span>
        <HashChain manifest={manifest} dryRun={dryRun} />
      </div>
    </div>
  );
}
