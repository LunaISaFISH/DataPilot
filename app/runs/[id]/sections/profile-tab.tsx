'use client';

import {
  Bar,
  DataTable,
  EmptyState,
  HashChip,
  KeyValueList,
  MaskedValue,
  MetricTile,
  PanelSection,
  Pill,
  type DataTableColumn,
} from '@/components/datapilot';
import { formatInt, formatMs, formatScore } from '@/lib/format';
import { pick, useLanguage } from '@/lib/language';
import { label } from '@/lib/labels';
import type { ColumnProfile } from '@/lib/types';

import { useWorkspace } from '../workspace-context';

export function ProfileTab() {
  const { t, language } = useLanguage();
  const { run } = useWorkspace();
  const report = run?.report ?? null;
  if (!report) {
    return <EmptyState title={t('No report yet', '尚无报告')} />;
  }
  const profile = report.profile;
  const observational = report.contract.source === 'baseline';

  const columns: DataTableColumn<ColumnProfile>[] = [
    { key: 'name', header: t('Column', '字段'), render: (row) => <span className="mono">{row.name}</span> },
    { key: 'inferred_type', header: t('Type', '类型'), render: (row) => label('inferred_type', row.inferred_type, language) },
    {
      key: 'non_null',
      header: t('Non-null', '非空率'),
      render: (row) => <Bar value={1 - row.null_rate} />,
    },
    { key: 'null_count', header: t('Empty', '空值'), align: 'right', render: (row) => formatInt(row.null_count) },
    { key: 'distinct_count', header: t('Distinct', '唯一值'), align: 'right', render: (row) => formatInt(row.distinct_count) },
    {
      key: 'top_values',
      header: t('Top values', 'Top 值'),
      render: (row) =>
        row.top_values.length === 0 ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          <span className="inline-flex max-w-[36ch] flex-wrap gap-x-2 gap-y-0.5">
            {row.top_values.map((top, index) => (
              <span key={`${top.value}-${index}`} className="inline-flex items-center gap-1">
                <MaskedValue value={top.value} patternClass={top.pattern_class} />
                <span className="text-[11px] text-muted-foreground">×{formatInt(top.count)}</span>
              </span>
            ))}
          </span>
        ),
    },
    {
      key: 'format_patterns',
      header: t('Formats', '格式分布'),
      render: (row) =>
        row.format_patterns.length === 0 ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          <span className="inline-flex flex-wrap gap-x-2 gap-y-0.5">
            {row.format_patterns.map((pattern) => (
              <span key={pattern.pattern} className="mono text-xs">
                {pattern.pattern} <span className="text-muted-foreground">×{formatInt(pattern.count)}</span>
              </span>
            ))}
          </span>
        ),
    },
    {
      key: 'contract_flags',
      header: t('Flags', '标记'),
      render: (row) =>
        row.contract_flags.length === 0 && row.sensitive_hit_count === 0 ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          <span className="inline-flex flex-wrap gap-1">
            {row.contract_flags.map((flag) => (
              <Pill key={flag} variant={flag === 'sensitive' ? 'blocker' : 'neutral'}>
                {label('contract_flag', flag, language)}
              </Pill>
            ))}
            {row.sensitive_hit_count > 0 ? (
              <Pill variant="blocker" title={t('Sensitive pattern hits', '敏感模式命中数')}>
                {t('hits', '命中')} {formatInt(row.sensitive_hit_count)}
              </Pill>
            ) : null}
          </span>
        ),
    },
    {
      key: 'range',
      header: t('Min / max', '最小 / 最大'),
      render: (row) =>
        row.min === null && row.max === null ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          <span className="mono text-xs">
            {row.min ?? '—'} <span className="text-muted-foreground">→</span> {row.max ?? '—'}
          </span>
        ),
    },
    { key: 'max_length', header: t('Max len', '最大长度'), align: 'right', render: (row) => formatInt(row.max_length) },
  ];

  const timings = Object.entries(report.timings_ms);
  const warnings = language === 'zh' ? report.warnings_zh : report.warnings_en;

  return (
    <div className="flex flex-col gap-3">
      <PanelSection
        id="profile-metrics"
        title={t('Quality metrics', '质量指标')}
        description={
          observational
            ? t('No contract: metrics are observational and the release status is not evaluated.', '尚未设置发布规则，本页只展示基础数据质量，不判断能否交付。')
            : t('Scored over the contract scope; not-applicable metrics are excluded and weights renormalised.', '质量分按发布规则覆盖的范围计算；不适用的指标不会计入总分。')
        }
        actions={
          <span className="mono text-[11px] text-muted-foreground">
            {profile.score_version} · {t('overall', '综合')} {formatScore(profile.overall_score)}
          </span>
        }
      >
        <div className="grid grid-cols-2 gap-2 xl:grid-cols-4">
          {profile.metrics.map((metric) => (
            <MetricTile key={metric.name} metric={metric} />
          ))}
        </div>
      </PanelSection>

      <PanelSection
        id="profile-columns"
        title={t('Column profiles', '字段概览')}
        description={`${formatInt(profile.column_count)} ${t('columns', '个字段')} · ${formatInt(profile.record_count)} ${t('records', '条记录')} · ${profile.source_encoding}`}
        flush
      >
        <DataTable columns={columns} rows={report.column_profiles} rowKey={(row) => row.name} maxHeight={520} ariaLabel={t('Column profiles', '字段概览')} />
      </PanelSection>

      <div className="grid gap-3 lg:grid-cols-2">
        <PanelSection id="profile-identity" title={t('Identity and scope', '标识与范围')}>
          <KeyValueList
            items={[
              { key: 'dataset', label: t('Dataset hash', '数据集哈希'), value: <HashChip value={profile.dataset_hash} length={16} /> },
              { key: 'scope', label: t('Scope hash', '评分范围哈希'), value: <HashChip value={profile.scope_hash} length={16} /> },
              { key: 'eval', label: t('Evaluation scope hash', '评估范围哈希'), value: <HashChip value={profile.evaluation_scope_hash} length={16} /> },
              { key: 'encoding', label: t('Source encoding', '源文件编码'), value: profile.source_encoding, mono: true },
              { key: 'engine', label: t('Engine', '引擎版本'), value: report.engine_version, mono: true },
              { key: 'schema', label: t('Report schema', '报告结构版本'), value: report.schema_version, mono: true },
              { key: 'revision', label: t('Run revision', '运行修订'), value: `r${report.run_revision}`, mono: true },
            ]}
          />
        </PanelSection>

        <PanelSection id="profile-timings" title={t('Timings and preflight', '耗时与敏感预检')}>
          <KeyValueList
            items={[
              ...timings.map(([stage, ms]) => ({ key: `t-${stage}`, label: `${t('Timing', '耗时')} · ${stage}`, value: formatMs(ms), mono: true })),
              {
                key: 'withheld',
                label: t('Columns withheld from AI', '对 AI 屏蔽的字段'),
                value:
                  report.sensitive_preflight.columns_withheld.length === 0 ? (
                    <span className="text-muted-foreground">0</span>
                  ) : (
                    <span className="inline-flex flex-wrap justify-end gap-1">
                      {report.sensitive_preflight.columns_withheld.map((column) => (
                        <Pill key={column} variant="blocker" className="mono font-normal">
                          {column}
                        </Pill>
                      ))}
                    </span>
                  ),
              },
              { key: 'masked', label: t('Cells masked', '已掩码单元格'), value: formatInt(report.sensitive_preflight.cells_masked), mono: true },
            ]}
          />
          {warnings.length > 0 ? (
            <ul className="mt-3 flex flex-col gap-1 border-t border-border pt-2 text-xs text-muted-foreground">
              {warnings.map((warning, index) => (
                <li key={index}>{pick(language, report.warnings_zh[index], report.warnings_en[index]) || warning}</li>
              ))}
            </ul>
          ) : null}
        </PanelSection>
      </div>
    </div>
  );
}
