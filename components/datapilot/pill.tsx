'use client';

import { useLanguage } from '@/lib/language';
import { label } from '@/lib/labels';
import type { AuthorizationMode, Lifecycle, ReleaseStatus, RiskLevel } from '@/lib/types';
import { cn } from '@/lib/utils';

export type PillVariant = 'policy' | 'review' | 'blocker' | 'ai' | 'neutral' | 'info';

export type PillProps = React.ComponentProps<'span'> & {
  variant?: PillVariant;
  dot?: boolean;
};

export function Pill({ variant = 'neutral', dot = false, className, children, ...props }: PillProps) {
  return (
    <span className={cn('pill', `pill-${variant}`, className)} data-variant={variant} {...props}>
      {dot ? <span aria-hidden="true" className="size-1.5 rounded-full bg-current" /> : null}
      {children}
    </span>
  );
}

const lifecycleVariant: Record<Lifecycle, PillVariant> = {
  QUEUED: 'neutral',
  RUNNING: 'info',
  REVIEW_REQUIRED: 'review',
  OBSERVATIONAL: 'neutral',
  DRY_RUN_READY: 'info',
  APPLIED: 'policy',
  FAILED: 'blocker',
};

export function LifecyclePill({ value, className }: { value: string; className?: string }) {
  const { language } = useLanguage();
  const variant = lifecycleVariant[value as Lifecycle] ?? 'neutral';
  return (
    <Pill variant={variant} dot={value === 'RUNNING' || value === 'QUEUED'} className={className}>
      {label('lifecycle', value, language)}
    </Pill>
  );
}

const riskVariant: Record<RiskLevel, PillVariant> = {
  LOW: 'neutral',
  MEDIUM: 'review',
  HIGH: 'blocker',
};

export function RiskPill({ value, className }: { value: string; className?: string }) {
  const { language } = useLanguage();
  return (
    <Pill variant={riskVariant[value as RiskLevel] ?? 'neutral'} className={className}>
      {label('risk', value, language)}
    </Pill>
  );
}

const releaseVariant: Record<ReleaseStatus, PillVariant> = {
  NOT_EVALUATED: 'neutral',
  BLOCKED: 'blocker',
  CONDITIONAL_PASS: 'review',
  PASS: 'policy',
};

export function ReleaseStatusPill({
  value,
  className,
}: {
  value: string | null | undefined;
  className?: string;
}) {
  const { language } = useLanguage();
  if (!value) return <Pill className={className}>—</Pill>;
  return (
    <Pill variant={releaseVariant[value as ReleaseStatus] ?? 'neutral'} className={className}>
      {label('release_status', value, language)}
    </Pill>
  );
}

const authVariant: Record<AuthorizationMode, PillVariant> = {
  POLICY_AUTHORIZED: 'policy',
  HUMAN_APPROVAL_REQUIRED: 'review',
  QUARANTINE_ONLY: 'blocker',
  FORBIDDEN: 'neutral',
};

export function AuthModePill({ value, className }: { value: string; className?: string }) {
  const { language } = useLanguage();
  return (
    <Pill variant={authVariant[value as AuthorizationMode] ?? 'neutral'} className={className}>
      {label('authorization_mode', value, language)}
    </Pill>
  );
}
