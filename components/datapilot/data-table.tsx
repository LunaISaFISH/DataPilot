'use client';

import type { CSSProperties, ReactNode } from 'react';

import { useLanguage } from '@/lib/language';
import { cn } from '@/lib/utils';

export type DataTableColumn<T> = {
  key: string;
  header: ReactNode;
  align?: 'left' | 'right' | 'center';
  width?: number | string;
  /** Custom cell renderer. Defaults to `String(row[key])`. */
  render?: (row: T, index: number) => ReactNode;
  className?: string;
  headerClassName?: string;
};

export type DataTableProps<T> = {
  columns: DataTableColumn<T>[];
  rows: T[];
  rowKey: (row: T, index: number) => string;
  onRowClick?: (row: T, index: number) => void;
  selectedKey?: string | null;
  maxHeight?: number | string;
  emptyTitle?: ReactNode;
  emptyDescription?: ReactNode;
  caption?: ReactNode;
  className?: string;
  tableClassName?: string;
  /** Compact 13px density is the default; pass false for 14px rows. */
  dense?: boolean;
  ariaLabel?: string;
};

function defaultCell<T>(row: T, key: string): ReactNode {
  const value = (row as unknown as Record<string, unknown>)[key];
  if (value === null || value === undefined) return <span className="text-muted-foreground">—</span>;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return value.toLocaleString('en-US');
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  selectedKey = null,
  maxHeight,
  emptyTitle,
  emptyDescription,
  caption,
  className,
  tableClassName,
  dense = true,
  ariaLabel,
}: DataTableProps<T>) {
  const { t } = useLanguage();
  const style: CSSProperties | undefined = maxHeight !== undefined ? { maxHeight } : undefined;
  const clickable = Boolean(onRowClick);

  return (
    <div className={cn('dp-table-wrap', className)} style={style}>
      <table className={cn('dp-table', !dense && 'text-sm', tableClassName)} aria-label={ariaLabel}>
        {caption ? <caption className="sr-only">{caption}</caption> : null}
        <thead>
          <tr>
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                data-align={column.align ?? 'left'}
                style={column.width !== undefined ? { width: column.width, minWidth: column.width } : undefined}
                className={column.headerClassName}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="py-8! text-center">
                <div className="text-sm font-medium text-foreground">{emptyTitle ?? t('No rows', '暂无数据')}</div>
                {emptyDescription ? (
                  <div className="mt-1 text-xs text-muted-foreground">{emptyDescription}</div>
                ) : null}
              </td>
            </tr>
          ) : (
            rows.map((row, index) => {
              const key = rowKey(row, index);
              const selected = selectedKey !== null && selectedKey === key;
              return (
                <tr
                  key={key}
                  data-clickable={clickable ? 'true' : undefined}
                  data-selected={selected ? 'true' : undefined}
                  aria-selected={clickable ? selected : undefined}
                  tabIndex={clickable ? 0 : undefined}
                  onClick={clickable ? () => onRowClick?.(row, index) : undefined}
                  onKeyDown={
                    clickable
                      ? (event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            onRowClick?.(row, index);
                          }
                        }
                      : undefined
                  }
                >
                  {columns.map((column) => (
                    <td
                      key={column.key}
                      data-align={column.align ?? 'left'}
                      className={cn(column.align === 'right' && 'cell-num', column.className)}
                    >
                      {column.render ? column.render(row, index) : defaultCell(row, column.key)}
                    </td>
                  ))}
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}
