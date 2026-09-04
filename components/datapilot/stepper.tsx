'use client';

import { Check, Lock } from 'lucide-react';

import { useLanguage } from '@/lib/language';
import { label, STEPPER_STAGES, type StepperStageId } from '@/lib/labels';
import { cn } from '@/lib/utils';

export type StepState = 'locked' | 'available' | 'active' | 'done';

export type StepperStep = {
  id: StepperStageId;
  state: StepState;
  /** Required for locked steps: why the stage is not reachable yet. */
  reason?: string;
  /** Short status line under the title (e.g. "8 个问题 · 3 待处置"). */
  detail?: string;
  title?: string;
};

export type StepperProps = {
  steps: StepperStep[];
  onSelect?: (id: StepperStageId) => void;
  className?: string;
};

/** Builds the seven steps with every step locked, for callers to override. */
export function defaultSteps(reason: string): StepperStep[] {
  return STEPPER_STAGES.map((id) => ({ id, state: 'locked', reason }));
}

export function Stepper({ steps, onSelect, className }: StepperProps) {
  const { language, t } = useLanguage();
  return (
    <ol className={cn('flex flex-col', className)} aria-label={t('Workspace stages', '工作区阶段')}>
      {steps.map((step, index) => {
        const last = index === steps.length - 1;
        const title = step.title ?? label('stepper_stage', step.id, language);
        const interactive = Boolean(onSelect) && step.state !== 'locked';
        const marker =
          step.state === 'done' ? (
            <Check aria-hidden="true" className="size-3" />
          ) : step.state === 'locked' ? (
            <Lock aria-hidden="true" className="size-3" />
          ) : (
            <span className="mono text-[11px] font-semibold">{step.id}</span>
          );
        return (
          <li key={step.id} className="relative flex gap-3" data-state={step.state} aria-current={step.state === 'active' ? 'step' : undefined}>
            <div className="flex flex-col items-center">
              <span
                className={cn(
                  'grid size-6 shrink-0 place-items-center rounded-full border text-xs',
                  step.state === 'done' && 'border-policy bg-policy text-primary-foreground',
                  step.state === 'active' && 'border-policy bg-policy-tint text-policy',
                  step.state === 'available' && 'border-border bg-card text-foreground',
                  step.state === 'locked' && 'border-border bg-muted text-muted-foreground',
                )}
              >
                {marker}
              </span>
              {!last ? <span aria-hidden="true" className={cn('w-px flex-1 my-1', step.state === 'done' ? 'bg-policy' : 'bg-border')} /> : null}
            </div>
            <button
              type="button"
              disabled={!interactive}
              onClick={interactive ? () => onSelect?.(step.id) : undefined}
              className={cn(
                'mb-3 min-w-0 flex-1 rounded-md px-2 py-1 text-left transition-colors',
                interactive && 'hover:bg-muted',
                step.state === 'active' && 'bg-policy-tint/60',
                !interactive && 'cursor-default',
              )}
            >
              <span
                className={cn(
                  'block text-[13px] font-semibold leading-5',
                  step.state === 'locked' ? 'text-muted-foreground' : 'text-foreground',
                )}
              >
                {title}
              </span>
              {step.state === 'locked' && step.reason ? (
                <span className="block text-[11px] leading-4 text-muted-foreground">{step.reason}</span>
              ) : step.detail ? (
                <span className="block text-[11px] leading-4 text-muted-foreground">{step.detail}</span>
              ) : null}
            </button>
          </li>
        );
      })}
    </ol>
  );
}
