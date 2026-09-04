'use client';

import { HashChip, InlineAlert } from '@/components/datapilot';
import { artifactUrl } from '@/lib/api';
import { formatBytes } from '@/lib/format';
import { useLanguage } from '@/lib/language';
import type { ArtifactInfo, ArtifactName } from '@/lib/types';

export const DOWNLOAD_NAMES: readonly ArtifactName[] = ['release.csv', 'candidate.csv', 'release-manifest.json', 'changes.jsonl', 'ai-ledger.jsonl', 'audit-bundle.json'];

const ROLE: Record<ArtifactName, readonly [zh: string, en: string]> = {
  'release.csv': ['发布文件（可发布记录，已排除字段移除）', 'Release file (releasable records, excluded columns removed)'],
  'candidate.csv': ['候选文件（应用动作后、过滤前）', 'Candidate file (after actions, before filtering)'],
  'release-manifest.json': ['发布清单（哈希链与计数）', 'Release manifest (hash chain and counts)'],
  'changes.jsonl': ['单元格级变更账本', 'Cell-level change ledger'],
  'ai-ledger.jsonl': ['AI 调用账本', 'AI call ledger'],
  'audit-bundle.json': ['审计包（报告 + 契约 + 处置 + 预演 + 执行 + 账本 + 清单）', 'Audit bundle (report + contract + decisions + dry run + execution + ledger + manifest)'],
};

export type DownloadsProps = {
  runId: string;
  artifacts: ArtifactInfo[];
};

/** Download list for the six governed artifacts, with bytes/sha256 from `GET /artifacts` when listed. */
export function Downloads({ runId, artifacts }: DownloadsProps) {
  const { t, language } = useLanguage();
  const byName = new Map(artifacts.map((artifact) => [artifact.name, artifact]));
  return (
    <div className="flex flex-col gap-2">
      <InlineAlert variant="warning" title={t('Spreadsheet safety', '电子表格安全提示')}>
        {t(
          'CSV values are preserved for auditability. Before opening release.csv or candidate.csv in Excel or Numbers, inspect cells beginning with =, +, - or @ because spreadsheet apps may interpret them as formulas.',
          '为保证审计一致性，CSV 会保留原始值。用 Excel 或 Numbers 打开 release.csv 或 candidate.csv 前，请检查以 =、+、-、@ 开头的单元格；电子表格软件可能将其解释为公式。',
        )}
      </InlineAlert>
      <ul className="flex flex-col divide-y divide-border">
        {DOWNLOAD_NAMES.map((name) => {
          const url = artifactUrl(runId, name);
          const info = byName.get(name) ?? null;
          return (
            <li key={name} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-1.5 text-xs">
              <span className="flex min-w-0 flex-col">
                {url ? (
                  <a href={url} download={name} className="mono underline underline-offset-2">
                    {name}
                  </a>
                ) : (
                  <span className="mono text-muted-foreground">{name}</span>
                )}
                <span className="text-[11px] text-muted-foreground">{language === 'zh' ? ROLE[name][0] : ROLE[name][1]}</span>
              </span>
              <span className="flex items-center gap-2">
                {info ? <span className="mono text-muted-foreground">{formatBytes(info.bytes)}</span> : <span className="text-[11px] text-muted-foreground">{t('assembled on request', '按需组装')}</span>}
                {info ? <HashChip value={info.sha256} length={12} /> : null}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
