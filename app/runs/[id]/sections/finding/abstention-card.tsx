'use client';

import { Pill, ProvenanceMark, provenanceFromProposal } from '@/components/datapilot';
import { useLanguage } from '@/lib/language';
import type { AICallRecord, AIProposalSummary } from '@/lib/types';

import { asString, asStringList } from './helpers';

/** The model declined to map: show its stated reason verbatim and what the engine did instead. */
export function AbstentionCard({ proposal, record }: { proposal: AIProposalSummary; record: AICallRecord | null }) {
  const { t } = useLanguage();
  const response = record?.response_payload ?? null;
  const explanation = response ? asString(response.semantic_explanation) : null;
  const flags = response ? asStringList(response.ambiguity_flags) : [];
  return (
    <div className="flex flex-col gap-2 rounded-md border border-border p-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <ProvenanceMark provenance={provenanceFromProposal(proposal)} showModel />
        <Pill variant="neutral">{t('Abstained', '暂不判断')}</Pill>
        <span className="text-xs text-muted-foreground">{t('No mapping was proposed; nothing is executed from this call.', 'AI 没有给出归一建议，系统不会自动改动数据。')}</span>
      </div>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted-foreground">{t('Abstain reason', '暂不判断的原因')}</dt>
        <dd className="break-words">{proposal.abstain_reason || <span className="text-muted-foreground">—</span>}</dd>
        {explanation && explanation !== proposal.abstain_reason ? (
          <>
            <dt className="text-muted-foreground">{t('Model explanation', '模型说明')}</dt>
            <dd className="break-words">{explanation}</dd>
          </>
        ) : null}
        {flags.length > 0 ? (
          <>
            <dt className="text-muted-foreground">{t('Ambiguity flags', '歧义标记')}</dt>
            <dd className="flex flex-wrap gap-1">
              {flags.map((flag) => (
                <Pill key={flag} variant="neutral" className="mono font-normal">
                  {flag}
                </Pill>
              ))}
            </dd>
          </>
        ) : null}
      </dl>
    </div>
  );
}
