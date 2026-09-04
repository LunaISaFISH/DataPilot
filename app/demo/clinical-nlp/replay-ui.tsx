'use client';

import type { ReactNode } from 'react';

import { HashChip, Pill, type Provenance } from '@/components/datapilot';
import { formatInt } from '@/lib/format';
import { useLanguage } from '@/lib/language';
import type { EvidenceSignal, ProviderName } from '@/lib/types';

import type { ReplayFinding, ReplayProposal } from './replay-data';

/** Rendered wherever the static artifact does not carry a value. */
export function Unavailable({ reason }: { reason?: ReactNode }) {
  const { t } = useLanguage();
  return (
    <span className="text-muted-foreground" title={typeof reason === 'string' ? reason : undefined}>
      {t('Unavailable', '不可用')}
      {reason ? <span className="text-[11px]"> · {reason}</span> : null}
    </span>
  );
}

/** Observed / expected cell shared with the console: HashChip for digests, mono text otherwise. */
export { isHashLike, ObservedValue as ObservedCell } from '@/components/datapilot';

/** Hash or 不可用. */
export function HashOrUnavailable({ value, label, length }: { value: string | null | undefined; label?: string; length?: number }) {
  if (!value) return <Unavailable />;
  return <HashChip value={value} label={label} length={length} />;
}

/** Integer or 不可用. */
export function IntOrUnavailable({ value }: { value: number | null | undefined }) {
  if (value === null || value === undefined) return <Unavailable />;
  return <span className="mono">{formatInt(value)}</span>;
}

const GLYPH: Record<EvidenceSignal['status'], string> = { PASS: '✓', FAIL: '✗', NOT_APPLICABLE: '–' };
const GLYPH_CLASS: Record<EvidenceSignal['status'], string> = { PASS: 'text-policy', FAIL: 'text-blocker', NOT_APPLICABLE: 'text-muted-foreground' };

/** ✓✗– row summarising the evidence signals of a finding. */
export function EvidenceGlyphs({ signals }: { signals: EvidenceSignal[] }) {
  const { t } = useLanguage();
  if (signals.length === 0) return <span className="text-muted-foreground">—</span>;
  return (
    <span className="mono inline-flex gap-0.5" aria-label={t('Evidence signals', '证据信号')}>
      {signals.map((signal) => (
        <span key={`${signal.signal}-${signal.evidence_ref}`} className={GLYPH_CLASS[signal.status] ?? 'text-muted-foreground'} title={`${signal.signal} · ${signal.status}`}>
          {GLYPH[signal.status] ?? '·'}
        </span>
      ))}
    </span>
  );
}

const KNOWN_PROVIDERS: ReadonlySet<string> = new Set<ProviderName>(['anthropic', 'deterministic', 'verified-replay']);

/** Provenance for the shared ProvenanceMark, built from a recorded proposal. */
export function provenanceFromReplayProposal(proposal: ReplayProposal): Provenance {
  const provider = (KNOWN_PROVIDERS.has(proposal.provider) ? proposal.provider : 'deterministic') as ProviderName;
  const grounding = proposal.grounding;
  return {
    provider,
    status: proposal.abstained ? 'abstained' : grounding && !grounding.valid ? 'rejected_by_grounding' : 'ok',
    model: proposal.model,
    prompt_version: proposal.prompt_version,
    input_hash: proposal.input_hash,
    grounding,
    reason: proposal.abstain_reason,
    ledger_call_id: proposal.ledger_call_id,
  };
}

export type ReplayAiCounters = { provider: string | null; proposed: number; abstained: number; rejected: number };

/**
 * 提议 / 弃权 / 被拒 over recorded proposals whose provider is not the deterministic engine.
 * Deterministic fallbacks are never counted as model work.
 */
export function replayAiCounters(findings: ReplayFinding[]): ReplayAiCounters {
  const counters: ReplayAiCounters = { provider: null, proposed: 0, abstained: 0, rejected: 0 };
  for (const finding of findings) {
    const proposal = finding.proposal;
    if (!proposal || proposal.provider === 'deterministic') continue;
    counters.provider ??= proposal.provider;
    if (proposal.abstained) counters.abstained += 1;
    else if (proposal.grounding && !proposal.grounding.valid) counters.rejected += 1;
    else counters.proposed += 1;
  }
  return counters;
}

/** Persistent badge for every replay surface. */
export function ReplayBadge({ className }: { className?: string }) {
  const { t } = useLanguage();
  return (
    <Pill variant="review" className={className} title={t('Recorded engine run; nothing on this page is live.', '已记录的引擎运行；本页没有任何实时内容。')}>
      {t('Offline replay · not live', '离线回放 · 非实时')}
    </Pill>
  );
}
