import type { Language } from '@/lib/language';

const intFormatter = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

/** 12345 → "12,345". Non-finite input renders as "—". */
export function formatInt(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return intFormatter.format(Math.round(value));
}

/** 0.9876 → "98.8%" (ratio input). Pass `digits` to change precision. */
export function formatPct(ratio: number | null | undefined, digits = 1): string {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return '—';
  return `${(ratio * 100).toFixed(digits)}%`;
}

/** Score in [0, 1] → two decimals, e.g. "0.97". */
export function formatScore(score: number | null | undefined): string {
  if (score === null || score === undefined || !Number.isFinite(score)) return '—';
  return score.toFixed(2);
}

/** First 10 hex characters of a hash. */
export function shortHash(value: string | null | undefined, length = 10): string {
  if (!value) return '—';
  return value.slice(0, length);
}

/** 842 → "842 ms", 12_340 → "12.3 s", 125_000 → "2 min 5 s". */
export function formatMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes} min ${seconds} s`;
}

/** Binary units: 1536 → "1.5 KiB". */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}

/** ISO timestamp → locale date-time in the active language (24 h clock). */
export function formatDateTime(iso: string | null | undefined, language: Language): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(language === 'zh' ? 'zh-CN' : 'en-GB', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date);
}

/** Time-of-day only, for dense event logs. */
export function formatTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * Display form for a possibly masked cell. The engine already replaces sensitive values with
 * masks such as "••••@••••"; this only normalises empties and appends the pattern class.
 */
export function maskedDisplay(value: string | null | undefined, patternClass?: string | null): string {
  if (value === null || value === undefined || value === '') return '∅';
  if (patternClass) return `${value} · ${patternClass}`;
  return value;
}

/** Humanise an enum-like token: "HUMAN_APPROVAL_REQUIRED" → "Human approval required". */
export function humanize(value: string): string {
  const spaced = value.replace(/[_-]+/g, ' ').trim().toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
