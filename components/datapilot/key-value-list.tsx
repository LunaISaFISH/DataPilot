import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

export type KeyValueItem = {
  key: string;
  label: ReactNode;
  value: ReactNode;
  mono?: boolean;
};

export type KeyValueListProps = {
  items: KeyValueItem[];
  columns?: 1 | 2 | 3;
  className?: string;
};

export function KeyValueList({ items, columns = 1, className }: KeyValueListProps) {
  return (
    <dl
      className={cn(
        'data-dense grid gap-x-6',
        columns === 1 && 'grid-cols-1',
        columns === 2 && 'grid-cols-1 sm:grid-cols-2',
        columns === 3 && 'grid-cols-1 sm:grid-cols-3',
        className,
      )}
    >
      {items.map((item) => (
        <div key={item.key} className="flex items-baseline justify-between gap-4 border-b border-border py-1.5 last:border-b-0">
          <dt className="shrink-0 text-muted-foreground">{item.label}</dt>
          <dd className={cn('min-w-0 text-right break-all', item.mono && 'mono text-xs')}>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
