'use client';

import { HashChip, Pill, ProvenanceMark, provenanceFromProposal } from '@/components/datapilot';
import { formatInt } from '@/lib/format';
import { useLanguage } from '@/lib/language';
import type { AICallRecord, Finding } from '@/lib/types';

import { asNumberMap, asString, asStringList } from './helpers';

type MappingRow = { source: string; target: string; count: number | null };

/**
 * The grounded model mapping that a human may approve. Counts come from the finding's
 * `details.observed_counts` when the detector recorded them, else from the recorded request's
 * `candidate_counts` (the same numbers the validator summed for its recount).
 */
export function ProposalCard({ finding, record }: { finding: Finding; record: AICallRecord | null }) {
  const { t } = useLanguage();
  const proposal = finding.proposal;
  if (!proposal || !proposal.mapping) return null;
  const observed = asNumberMap(finding.details.observed_counts);
  const candidates = asNumberMap(record?.request_payload?.candidate_counts);
  const countSource = Object.keys(observed).length > 0 ? 'details' : Object.keys(candidates).length > 0 ? 'request' : null;
  const counts = countSource === 'details' ? observed : candidates;
  const rows: MappingRow[] = Object.entries(proposal.mapping).map(([source, target]) => ({
    source,
    target,
    count: counts[source] ?? null,
  }));
  const total = rows.reduce<number>((sum, row) => sum + (row.count ?? 0), 0);
  const response = record?.response_payload ?? null;
  const explanation = response ? asString(response.semantic_explanation) : null;
  const evidenceRefs = response ? asStringList(response.evidence_refs) : [];
  const targets = new Set(rows.map((row) => row.target));

  return (
    <div className="flex flex-col gap-2 rounded-md border border-border p-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <ProvenanceMark provenance={provenanceFromProposal(proposal)} showModel />
        <Pill variant={proposal.grounding.valid ? 'policy' : 'blocker'}>{proposal.grounding.valid ? t('Grounded', '已接地') : t('Rejected', '已拒绝')}</Pill>
        <span className="text-xs text-muted-foreground">
          {formatInt(rows.length)} {t('sources', '来源值')} → {formatInt(targets.size)} {t('targets', '目标值')}
        </span>
        <HashChip value={proposal.input_hash} label="input_hash" />
      </div>
      <div className="dp-table-wrap">
        <table className="dp-table">
          <thead>
            <tr>
              <th>{t('Source (observed)', '来源值（观测到）')}</th>
              <th>{t('Target (vocabulary)', '目标值（词表）')}</th>
              <th data-align="right">{t('Records', '记录')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.source}>
                <td className="mono text-xs break-all">{row.source}</td>
                <td className="mono text-xs break-all">{row.target}</td>
                <td className="cell-num text-xs">{row.count === null ? <span className="text-muted-foreground">—</span> : formatInt(row.count)}</td>
              </tr>
            ))}
          </tbody>
          {countSource ? (
            <tfoot>
              <tr>
                <td colSpan={2} className="text-[11px] text-muted-foreground">
                  {countSource === 'details' ? t('counts: report details.observed_counts', '计数来源：报告 details.observed_counts') : t('counts: recorded request candidate_counts', '计数来源：记录的请求 candidate_counts')}
                </td>
                <td className="cell-num text-xs">{formatInt(total)}</td>
              </tr>
            </tfoot>
          ) : null}
        </table>
      </div>
      {explanation ? (
        <p className="text-xs leading-4">
          <span className="text-muted-foreground">{t('Model explanation', '模型说明')} · </span>
          {explanation}
        </p>
      ) : null}
      {evidenceRefs.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
          <span>{t('Evidence refs cited', '引用的证据编号')}</span>
          {evidenceRefs.map((ref) => (
            <Pill key={ref} variant="neutral" className="mono font-normal">
              {ref}
            </Pill>
          ))}
        </div>
      ) : null}
    </div>
  );
}
