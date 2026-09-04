import { AlertTriangle, Info, OctagonX } from 'lucide-react';
import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

export type InlineAlertProps = {
  variant?: 'info' | 'warning' | 'error';
  title?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  className?: string;
};

const styles = {
  info: { box: 'border-info/25 bg-info-tint text-info', Icon: Info },
  warning: { box: 'border-review/25 bg-review-tint text-review', Icon: AlertTriangle },
  error: { box: 'border-blocker/25 bg-blocker-tint text-blocker', Icon: OctagonX },
} as const;

export function InlineAlert({ variant = 'info', title, children, actions, className }: InlineAlertProps) {
  const { box, Icon } = styles[variant];
  return (
    <div
      role={variant === 'error' ? 'alert' : 'status'}
      className={cn('flex items-start gap-2.5 rounded-md border px-3 py-2 text-[13px] leading-5', box, className)}
    >
      <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 flex-1">
        {title ? <div className="font-semibold">{title}</div> : null}
        {children ? <div className={cn(title && 'mt-0.5')}>{children}</div> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}
