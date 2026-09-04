'use client';

import { useId, useRef } from 'react';

import { useLanguage } from '@/lib/language';
import { cn } from '@/lib/utils';

export type YamlEditorProps = {
  value: string;
  onChange?: (value: string) => void;
  readOnly?: boolean;
  minRows?: number;
  maxHeight?: number;
  ariaLabel?: string;
  className?: string;
  invalid?: boolean;
};

/** Monospace textarea with a line-number gutter. Plain textarea, no syntax highlighting. */
export function YamlEditor({
  value,
  onChange,
  readOnly = false,
  minRows = 12,
  maxHeight = 480,
  ariaLabel,
  className,
  invalid = false,
}: YamlEditorProps) {
  const { t } = useLanguage();
  const id = useId();
  const gutter = useRef<HTMLDivElement | null>(null);
  const lines = value === '' ? 1 : value.split('\n').length;
  const rows = Math.max(minRows, Math.min(lines + 1, Math.floor(maxHeight / 20)));

  return (
    <div className={cn('yaml-editor', invalid && 'border-blocker', className)} data-readonly={readOnly}>
      <div ref={gutter} className="yaml-gutter" aria-hidden="true" style={{ maxHeight }}>
        {Array.from({ length: lines }, (_, i) => (
          <span key={i}>{i + 1}</span>
        ))}
      </div>
      <textarea
        id={id}
        value={value}
        readOnly={readOnly || !onChange}
        rows={rows}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        wrap="off"
        aria-label={ariaLabel ?? t('Data Contract YAML', '数据契约 YAML')}
        aria-invalid={invalid || undefined}
        style={{ maxHeight }}
        onChange={onChange ? (event) => onChange(event.target.value) : undefined}
        onScroll={(event) => {
          if (gutter.current) gutter.current.scrollTop = event.currentTarget.scrollTop;
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Tab' || readOnly || !onChange) return;
          event.preventDefault();
          const target = event.currentTarget;
          const { selectionStart, selectionEnd } = target;
          const next = `${value.slice(0, selectionStart)}  ${value.slice(selectionEnd)}`;
          onChange(next);
          requestAnimationFrame(() => {
            target.selectionStart = selectionStart + 2;
            target.selectionEnd = selectionStart + 2;
          });
        }}
      />
    </div>
  );
}
