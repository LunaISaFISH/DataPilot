'use client';

import { Bar, DataTable, EmptyState, EventLog, KeyValueList, MaskedValue, MetricTile, PanelSection, Pill, type DataTableColumn, type KeyValueItem } from '@/components/datapilot';
import { formatInt, formatMs, formatScore } from '@/lib/format';
import { useLanguage } from '@/lib/language';
import { label } from '@/lib/labels';
import type { ColumnProfile } from '@/lib/types';

import type { ReplayBundle } from './replay-data';
import { HashOrUnavailable, IntOrUnavailable, Unavailable } from './replay-ui';

export function ReplayOverviewTab({ bundle }: { bundle: ReplayBundle }) {
  const { t, language } = useLanguage();
  const report = bundle.report;
  if (!report) {
    return <EmptyState title={t('report.json is unavailable', 'report.json 不可用')} description={t('The overview needs the analysis report.', '概览需要分析报告。')} />;
  }
  const profile = report.profile;
  const contract = report.contract;
  const preflight = report.sensitive_preflight;
  const warnings = language === 'zh' ? report.warnings_zh : report.warnings_en;
  const timings = Object.entries(report.timings_ms);

  const summary: KeyValueItem[] = [
    { key: 'engine', label: t('Engine version', '引擎版本'), value: report.engine_version ?? <Unavailable />, mono: true },
    { key: 'schema', label: t('Schema version', '报告结构版本'), value: report.schema_version ?? <Unavailable />, mono: true },
    { key: 'fixture', label: t('Fixture version', '样例版本'), value: report.fixture_version ?? <Unavailable />, mono: true },
    { key: 'score_version', label: t('Score version', '评分版本'), value: profile.score_version ?? <Unavailable />, mono: true },
    { key: 'revision', label: t('Run revision', '运行版本号'), value: <IntOrUnavailable value={report.run_revision} /> },
    {
      key: 'synthetic',
      label: t('Data origin', '数据来源'),
      value: report.synthetic === null ? <Unavailable /> : report.synthetic ? t('Synthetic', '合成数据') : t('Not marked synthetic', '未标记为合成'),
    },
    { key: 'dataset', label: t('Dataset hash', '数据集哈希'), value: <HashOrUnavailable value={profile.dataset_hash} length={16} /> },
    { key: 'scope', label: t('Scope hash', '评分范围哈希'), value: <HashOrUnavailable value={profile.scope_hash} length={16} /> },
    { key: 'eval', label: t('Evaluation scope hash', '评估范围哈希'), value: <HashOrUnavailable value={profile.evaluation_scope_hash} length={16} /> },
    {
      key: 'contract',
      label: t('Contract', '契约'),
      value: contract ? (
        <span className="inline-flex flex-wrap items-center justify-end gap-1.5">
          <span className="mono text-xs">{contract.id ?? '—'}@{contract.version ?? '—'}</span>
          <Pill variant="neutral">{label('contract_source', contract.source, language)}</Pill>
          {contract.field_count !== null ? <span className="text-xs text-muted-foreground">{formatInt(contract.field_count)} {t('fields', '个字段')}</span> : null}
          <HashOrUnavailable value={contract.hash} />
        </span>
      ) : (
        <Unavailable reason={t('not in this artifact', '工件未包含')} />
      ),
    },
    {
      key: 'preflight',
      label: t('Sensitive preflight', '敏感预检'),
      value: preflight ? (
        <span>
          {t('withheld', '屏蔽字段')} {formatInt(preflight.columns_withheld.length)}
          {preflight.columns_withheld.length > 0 ? <span className="mono text-xs"> ({preflight.columns_withheld.join(', ')})</span> : null}
          {' · '}
          {t('masked cells', '掩码单元格')} {preflight.cells_masked === null ? '—' : formatInt(preflight.cells_masked)}
        </span>
      ) : (
        <Unavailable reason={t('not in this artifact', '工件未包含')} />
      ),
    },
  ];

  const columns: DataTableColumn<ColumnProfile>[] = [
    { key: 'name', header: t('Column', '字段'), render: (row) => <span className="mono">{row.name}</span> },
    { key: 'inferred_type', header: t('Type', '类型'), render: (row) => label('inferred_type', row.inferred_type, language) },
    { key: 'non_null', header: t('Non-null', '非空率'), render: (row) => <Bar value={1 - row.null_rate} /> },
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
  ];

  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <PanelSection id="replay-summary" title={t('Recorded run', '已记录的运行')} description={t('Values read from report.json', '读取自 report.json')}>
          <KeyValueList items={summary} />
        </PanelSection>
        <PanelSection
          id="replay-events"
          title={t('Recorded events', '已记录事件')}
          description={t('Static log of the recorded pipeline; timestamps show — when the artifact has none.', '已记录流水线的静态日志；工件无时间戳时显示 —。')}
        >
          <EventLog events={bundle.events} mode="expanded" maxHeight={260} autoscroll={false} live={false} emptyText={t('events.json is unavailable or empty', 'events.json 不可用或为空')} />
        </PanelSection>
      </div>

      <PanelSection
        id="replay-metrics"
        title={t('Quality metrics at analysis', '分析时的质量指标')}
        actions={
          <span className="mono text-[11px] text-muted-foreground">
            {profile.score_version ?? '—'} · {t('overall', '综合')} {formatScore(profile.overall_score)}
          </span>
        }
      >
        {profile.metrics.length === 0 ? (
          <Unavailable reason={t('no metrics in this artifact', '工件未包含指标')} />
        ) : (
          <div className="grid grid-cols-2 gap-2 xl:grid-cols-4">
            {profile.metrics.map((metric) => (
              <MetricTile key={metric.name} metric={metric} />
            ))}
          </div>
        )}
      </PanelSection>

      <PanelSection
        id="replay-columns"
        title={t('Column profiles', '列画像')}
        description={`${profile.column_count === null ? '—' : formatInt(profile.column_count)} ${t('columns', '个字段')} · ${profile.record_count === null ? '—' : formatInt(profile.record_count)} ${t('records', '条记录')}`}
        flush
      >
        {report.column_profiles.length === 0 ? (
          <div className="p-3">
            <EmptyState
              title={t('Column profiles unavailable', '列画像不可用')}
              description={t('This replay artifact does not carry column_profiles.', '此回放工件未包含 column_profiles。')}
            />
          </div>
        ) : (
          <DataTable columns={columns} rows={report.column_profiles} rowKey={(row) => row.name} maxHeight={480} className="rounded-none border-0" ariaLabel={t('Column profiles', '列画像')} />
        )}
      </PanelSection>

      {timings.length > 0 || warnings.length > 0 ? (
        <div className="grid gap-3 xl:grid-cols-2">
          {timings.length > 0 ? (
            <PanelSection id="replay-timings" title={t('Stage timings', '阶段耗时')}>
              <KeyValueList items={timings.map(([stage, ms]) => ({ key: stage, label: <span className="mono">{stage}</span>, value: formatMs(ms), mono: true }))} />
            </PanelSection>
          ) : null}
          {warnings.length > 0 ? (
            <PanelSection id="replay-warnings" title={t('Engine warnings', '引擎警告')}>
              <ul className="list-disc space-y-1 pl-5 text-[13px]">
                {warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </PanelSection>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
