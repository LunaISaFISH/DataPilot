'use client';

import { LoaderCircle } from 'lucide-react';
import type { ReactNode } from 'react';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useLanguage } from '@/lib/language';
import { cn } from '@/lib/utils';

export type ConfirmDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  /** Extra body content (e.g. a KeyValueList of hashes and counts). */
  children?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  pending?: boolean;
  onConfirm: () => void | Promise<void>;
  className?: string;
};

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  confirmLabel,
  cancelLabel,
  destructive = false,
  pending = false,
  onConfirm,
  className,
}: ConfirmDialogProps) {
  const { t } = useLanguage();
  return (
    <AlertDialog open={open} onOpenChange={(next) => (pending ? undefined : onOpenChange(next))}>
      <AlertDialogContent className={cn('sm:max-w-md', className)}>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {description ? <AlertDialogDescription>{description}</AlertDialogDescription> : null}
        </AlertDialogHeader>
        {children ? <div className="text-sm">{children}</div> : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>{cancelLabel ?? t('Cancel', '取消')}</AlertDialogCancel>
          <AlertDialogAction
            variant={destructive ? 'destructive' : 'default'}
            disabled={pending}
            onClick={() => void onConfirm()}
          >
            {pending ? <LoaderCircle data-icon="inline-start" className="animate-spin" /> : null}
            {confirmLabel ?? t('Confirm', '确认')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
