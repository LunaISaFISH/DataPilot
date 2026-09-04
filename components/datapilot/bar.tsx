import { formatPct } from '@/lib/format';
import { cn } from '@/lib/utils';

export type BarProps = {
  /** Ratio in [0, 1]. */
  value: number | null | undefined;
  tone?: 'policy' | 'review' | 'blocker' | 'ai' | 'neutral' | 'auto';
  width?: number;
  showLabel?: boolean;
  digits?: number;
  className?: string;
};

const toneClass = {
  policy: 'bg-policy',
  review: 'bg-review',
  blocker: 'bg-blocker',
  ai: 'bg-ai',
  neutral: 'bg-muted-foreground',
} as const;

function autoTone(ratio: number): keyof typeof toneClass {
  if (ratio >= 0.98) return 'policy';
  if (ratio >= 0.9) return 'review';
  return 'blocker';
}

/** Inline percentage bar with a tabular label; safe for table cells. */
export function Bar({ value, tone = 'auto', width = 64, showLabel = true, digits = 1, className }: BarProps) {
  const ratio = value === null || value === undefined || !Number.isFinite(value) ? null : Math.min(1, Math.max(0, value));
  const resolvedTone = ratio === null ? 'neutral' : tone === 'auto' ? autoTone(ratio) : tone;
  return (
    <span className={cn('inline-flex items-center gap-2', className)}>
      <span
        className="relative inline-block h-1.5 overflow-hidden rounded-sm bg-muted"
        style={{ width }}
        aria-hidden="true"
      >
        <span
          className={cn('absolute inset-y-0 left-0', toneClass[resolvedTone])}
          style={{ width: `${(ratio ?? 0) * 100}%` }}
        />
      </span>
      {showLabel ? (
        <span className="mono text-xs text-muted-foreground">{formatPct(ratio, digits)}</span>
      ) : (
        <span className="sr-only">{formatPct(ratio, digits)}</span>
      )}
    </span>
  );
}
