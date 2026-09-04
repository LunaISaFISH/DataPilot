'use client';

import type { ReactNode } from 'react';

import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { cn } from '@/lib/utils';

export type DrawerProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  /** Tailwind max-width class for ≥ sm screens. */
  width?: 'md' | 'lg' | 'xl' | '2xl';
  className?: string;
};

const widthClass = {
  md: 'data-[side=right]:sm:max-w-md',
  lg: 'data-[side=right]:sm:max-w-lg',
  xl: 'data-[side=right]:sm:max-w-xl',
  '2xl': 'data-[side=right]:sm:max-w-2xl',
} as const;

/** Right-side wide sheet for finding details and similar inspectors. */
export function Drawer({ open, onOpenChange, title, description, children, footer, width = '2xl', className }: DrawerProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className={cn('w-full gap-0 data-[side=right]:w-full', widthClass[width], className)}>
        <SheetHeader className="border-b border-border pr-12">
          <SheetTitle className="text-sm">{title}</SheetTitle>
          {description ? <SheetDescription className="text-xs">{description}</SheetDescription> : null}
        </SheetHeader>
        <div className="data-dense min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
        {footer ? <SheetFooter className="border-t border-border">{footer}</SheetFooter> : null}
      </SheetContent>
    </Sheet>
  );
}
