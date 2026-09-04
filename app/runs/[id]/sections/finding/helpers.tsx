'use client';

import type { ReactNode } from 'react';

import { formatInt } from '@/lib/format';
import { useLanguage, type Language } from '@/lib/language';
import { findingPrefixOf, label } from '@/lib/labels';
import type { AICallRecord, AuthorizationMode, Finding, RiskLevel, RunDetail } from '@/lib/types';
import { cn } from '@/lib/utils';

// Shared helpers for the 发现 table, the right-pane inspector and the 处置 pane. Everything here
// derives from real API objects (Finding, AICallRecord, RunDetail); nothing is invented.

// ---------------------------------------------------------------------------
// Unknown-payload readers (ledger request/response payloads are untyped JSON)
// ---------------------------------------------------------------------------

export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export function asStringMap(value: unknown): Record<string, string> {
  const record = asRecord(value);
  if (!record) return {};
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(record)) if (typeof entry === 'string') out[key] = entry;
  return out;
}

export function asNumberMap(value: unknown): Record<string, number> {
  const record = asRecord(value);
  if (!record) return {};
  const out: Record<string, number> = {};
  for (const [key, entry] of Object.entries(record)) if (typeof entry === 'number') out[key] = entry;
  return out;
}

export function asStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

export function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

// ---------------------------------------------------------------------------
// Finding classification
// ---------------------------------------------------------------------------

export function isSemFinding(findingId: string): boolean {
  return findingPrefixOf(findingId) === 'SEM' && !findingId.endsWith('-CONFLICT');
}

export type ProposalSource = 'ai' | 'ai_abstained' | 'ai_rejected' | 'deterministic' | 'ineligible';

/**
 * 提议来源: AI (model proposal passed grounding), AI abstained, AI rejected by grounding (the
 * executed fallback is deterministic), deterministic (engine proposal, no model), or ineligible
 * (nothing can be proposed: no action, quarantine-only or forbidden).
 */
export function proposalSource(finding: Finding, record: AICallRecord | null = null): ProposalSource {
  const proposal = finding.proposal;
  if (proposal && proposal.provider === 'anthropic') {
    if (proposal.abstained) return 'ai_abstained';
    if (!proposal.grounding.valid) return 'ai_rejected';
    return 'ai';
  }
  // After a grounding rejection the engine substitutes its deterministic proposal; the ledger
  // record still says the model was asked and refused by the validator.
  if (record && record.provider === 'anthropic' && record.status === 'rejected_by_grounding') return 'ai_rejected';
  if (proposal) return 'deterministic';
  if (finding.proposed_action === null) return 'ineligible';
  if (finding.authorization_mode === 'QUARANTINE_ONLY' || finding.authorization_mode === 'FORBIDDEN') return 'ineligible';
  return 'deterministic';
}

/** Ledger record behind a finding: the linked call first, else the latest semantic call for it. */
export function ledgerRecordFor(finding: Finding, ledger: AICallRecord[]): AICallRecord | null {
  const linked = finding.proposal?.ledger_call_id;
  if (linked) {
    const byId = ledger.find((record) => record.call_id === linked);
    if (byId) return byId;
  }
  const semantic = ledger.filter((record) => record.finding_id === finding.finding_id && record.task === 'semantic');
  return semantic.length > 0 ? semantic[semantic.length - 1] : null;
}

/** Latest red-team ledger record for a finding (only LIVE_INJECTION / TIMEOUT write one). */
export function redteamRecordsFor(finding: Finding, ledger: AICallRecord[]): AICallRecord[] {
  return ledger.filter((record) => record.finding_id === finding.finding_id && record.task === 'redteam');
}

export type DispositionView = {
  /** Localized text. */
  text: string;
  tone: 'policy' | 'review' | 'blocker' | 'neutral' | 'info';
  /** Where the value came from: dry-run dispositions, saved decision, or the report. */
  source: 'dry_run' | 'decision' | 'report';
};

/** 处置 column: dry-run disposition first, then the saved human decision, then the report's own. */
export function dispositionOf(finding: Finding, run: RunDetail | null, language: Language): DispositionView {
  const fromDryRun = run?.dry_run?.finding_dispositions[finding.finding_id];
  if (fromDryRun) {
    return { text: label('disposition', fromDryRun, language), tone: dispositionTone(fromDryRun), source: 'dry_run' };
  }
  const decision = run?.decisions[finding.finding_id];
  if (decision) {
    return {
      text: label('decision_outcome', decision.outcome, language),
      tone: decision.outcome === 'REJECT_PROPOSAL' ? 'blocker' : decision.outcome === 'APPROVE_PROPOSAL' ? 'policy' : 'info',
      source: 'decision',
    };
  }
  return { text: label('disposition', finding.disposition, language), tone: dispositionTone(finding.disposition), source: 'report' };
}

function dispositionTone(value: string): DispositionView['tone'] {
  switch (value) {
    case 'POLICY_AUTHORIZED':
    case 'APPROVED':
    case 'RESOLVED':
      return 'policy';
    case 'PROPOSAL_REJECTED':
      return 'blocker';
    case 'OPEN':
      return 'review';
    case 'QUARANTINED':
    case 'EXCLUDED':
    case 'FLAGGED':
      return 'info';
    default:
      return 'neutral';
  }
}

// ---------------------------------------------------------------------------
// Small presentational atoms (colour reserved for state)
// ---------------------------------------------------------------------------

const riskDot: Record<RiskLevel, string> = {
  HIGH: 'bg-blocker',
  MEDIUM: 'bg-review',
  LOW: 'bg-muted-foreground',
};

/** Coloured dot + text; never a tinted pill (spec §9.1). */
export function RiskDot({ value, className }: { value: string; className?: string }) {
  const { language } = useLanguage();
  const tone = riskDot[value as RiskLevel] ?? 'bg-muted-foreground';
  return (
    <span className={cn('inline-flex items-center gap-1.5 whitespace-nowrap', className)}>
      <span aria-hidden="true" className={cn('inline-block size-2 rounded-full', tone)} />
      <span>{label('risk', value, language)}</span>
    </span>
  );
}

const authCode: Record<AuthorizationMode, string> = {
  POLICY_AUTHORIZED: 'POLICY',
  HUMAN_APPROVAL_REQUIRED: 'HUMAN',
  QUARANTINE_ONLY: 'QUAR_ONLY',
  FORBIDDEN: 'FORBIDDEN',
};

const authTone: Record<AuthorizationMode, string> = {
  POLICY_AUTHORIZED: 'text-policy border-policy/30',
  HUMAN_APPROVAL_REQUIRED: 'text-review border-review/30',
  QUARANTINE_ONLY: 'text-blocker border-blocker/30',
  FORBIDDEN: 'text-muted-foreground border-border',
};

/** Authorization mode as a short code chip; the Chinese label and the full code sit in the tooltip. */
export function AuthCodeChip({ value, className }: { value: string; className?: string }) {
  const { language } = useLanguage();
  const code = authCode[value as AuthorizationMode] ?? value;
  const tone = authTone[value as AuthorizationMode] ?? 'text-muted-foreground border-border';
  return (
    <span
      className={cn('mono inline-flex h-5 items-center rounded-sm border bg-card px-1.5 text-[11px] font-semibold', tone, className)}
      title={`${label('authorization_mode', value, language)} · ${value}`}
      aria-label={`${label('authorization_mode', value, language)} (${value})`}
    >
      {code}
    </span>
  );
}

/** Mono JSON block for payloads shown verbatim. */
export function JsonBlock({ value, className, maxHeight = 240 }: { value: unknown; className?: string; maxHeight?: number }) {
  const text = value === undefined ? '—' : typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return (
    <pre
      className={cn('mono overflow-auto rounded-md border border-border bg-muted px-2 py-1.5 text-[11px] leading-4 break-all whitespace-pre-wrap', className)}
      style={{ maxHeight }}
    >
      {text}
    </pre>
  );
}

/** `label value` pair for compact stat strips. */
export function Stat({ k, v, tone, title }: { k: ReactNode; v: ReactNode; tone?: 'policy' | 'review' | 'blocker' | 'ai' | 'muted'; title?: string }) {
  return (
    <span className="inline-flex items-baseline gap-1 whitespace-nowrap" title={title}>
      <span className="text-[11px] text-muted-foreground">{k}</span>
      <span
        className={cn(
          'mono text-xs',
          tone === 'policy' && 'text-policy',
          tone === 'review' && 'text-review',
          tone === 'blocker' && 'text-blocker',
          tone === 'ai' && 'text-ai',
          tone === 'muted' && 'text-muted-foreground',
        )}
      >
        {v}
      </span>
    </span>
  );
}

export function countText(value: number | null | undefined): string {
  return formatInt(value);
}
