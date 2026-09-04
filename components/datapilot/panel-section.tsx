import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

export type PanelSectionProps = {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  id?: string;
  className?: string;
  bodyClassName?: string;
  /** Remove body padding for edge-to-edge tables. */
  flush?: boolean;
};

export function PanelSection({ title, description, actions, children, id, className, bodyClassName, flush = false }: PanelSectionProps) {
  return (
    <section id={id} className={cn('panel flex flex-col', className)} aria-labelledby={id ? `${id}-title` : undefined}>
      <header className="flex flex-wrap items-start justify-between gap-2 border-b border-border px-3 py-2">
        <div className="min-w-0">
          <h2 id={id ? `${id}-title` : undefined} className="text-[13px] font-semibold leading-5">
            {title}
          </h2>
          {description ? <p className="text-xs leading-4 text-muted-foreground">{description}</p> : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </header>
      {children !== undefined ? <div className={cn(!flush && 'p-3', bodyClassName)}>{children}</div> : null}
    </section>
  );
}
