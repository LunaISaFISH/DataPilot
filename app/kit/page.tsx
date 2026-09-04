'use client';

import { FileSearch } from 'lucide-react';
import { useState } from 'react';

import {
  AuthModePill,
  Bar,
  ConfirmDialog,
  CopyButton,
  DataTable,
  Drawer,
  EmptyState,
  EventLog,
  HashChip,
  InlineAlert,
  KeyValueList,
  LifecyclePill,
  MaskedValue,
  MetricTile,
  PanelSection,
  Pill,
  ProvenanceMark,
  ReleaseStatusPill,
  RiskPill,
  Stepper,
  YamlEditor,
  provenanceFromRecord,
  type DataTableColumn,
  type StepperStep,
} from '@/components/datapilot';
import { Button } from '@/components/ui/button';
import { formatBytes, formatDateTime, formatInt, formatMs, formatPct, formatScore } from '@/lib/format';
import { pick, useLanguage } from '@/lib/language';
import { label, labelKeys } from '@/lib/labels';
import type {
  AICallRecord,
  AuthorizationMode,
  ColumnProfile,
  Lifecycle,
  MetricScore,
  ReleaseStatus,
  RiskLevel,
  RunEvent,
  ValidationResult,
} from '@/lib/types';

// Everything on this page is illustrative sample data (示例) for visual review of the design
// system. No number here comes from the engine; product pages never import from this file.

const SAMPLE_HASH = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const SAMPLE_HASH_2 = '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08';

const sampleMetrics: MetricScore[] = [
  { name: 'completeness', numerator: 51_873, denominator: 52_000, score: 0.9976, scope_zh: '契约必填字段的非空单元格', scope_en: 'Non-empty cells over required fields', applicable: true },
  { name: 'validity', numerator: 30_912, denominator: 31_200, score: 0.9908, scope_zh: '已声明类型/格式/范围的单元格', scope_en: 'Cells conforming to declared type/format/range', applicable: true },
  { name: 'consistency', numerator: 0, denominator: 0, score: null, scope_zh: '未声明词表；不适用', scope_en: 'No vocabulary declared; not applicable', applicable: false },
  { name: 'uniqueness', numerator: 5_157, denominator: 5_200, score: 0.9917, scope_zh: '行数减去完全重复与业务键冲突', scope_en: 'Rows minus exact-duplicate and key surplus', applicable: true },
];

const sampleColumns: ColumnProfile[] = [
  { name: 'order_id', inferred_type: 'string', null_count: 0, null_rate: 0, distinct_count: 7_960, top_values: [{ value: 'ORD-000120', count: 2, pattern_class: null }], min: null, max: null, max_length: 10, format_patterns: [{ pattern: 'mixed', count: 8_000 }], sensitive_hit_count: 0, contract_flags: ['required', 'unique'] },
  { name: 'customer_phone', inferred_type: 'string', null_count: 12, null_rate: 0.0015, distinct_count: 7_870, top_values: [{ value: '1••••••••••', count: 3, pattern_class: 'cn_mobile' }], min: null, max: null, max_length: 11, format_patterns: [{ pattern: 'digits', count: 7_988 }], sensitive_hit_count: 7_988, contract_flags: ['sensitive'] },
  { name: 'order_date', inferred_type: 'date', null_count: 0, null_rate: 0, distinct_count: 365, top_values: [{ value: '2026-03-14', count: 41, pattern_class: null }], min: '2025-09-01', max: '2026-08-31', max_length: 10, format_patterns: [{ pattern: 'YYYY-MM-DD', count: 7_450 }, { pattern: 'DD/MM/YYYY', count: 400 }, { pattern: 'YYYY/MM/DD', count: 150 }], sensitive_hit_count: 0, contract_flags: ['date'] },
  { name: 'city', inferred_type: 'string', null_count: 0, null_rate: 0, distinct_count: 14, top_values: [{ value: '上海', count: 2_610, pattern_class: null }, { value: '北京', count: 2_120, pattern_class: null }, { value: 'Shanghai', count: 180, pattern_class: null }], min: null, max: null, max_length: 8, format_patterns: [{ pattern: 'mixed', count: 8_000 }], sensitive_hit_count: 0, contract_flags: ['canonical', 'allowed', 'semantic'] },
  { name: 'amount', inferred_type: 'number', null_count: 0, null_rate: 0, distinct_count: 6_412, top_values: [{ value: '99.00', count: 88, pattern_class: null }], min: '-120.00', max: '9800.00', max_length: 8, format_patterns: [{ pattern: 'digits', count: 8_000 }], sensitive_hit_count: 0, contract_flags: [] },
];

const sampleEvents: RunEvent[] = [
  { seq: 1, ts: '2026-09-04T09:12:01.120Z', stage: 'INGESTING', status: 'STARTED', message_zh: '接收上传文件', message_en: 'Receiving upload', elapsed_ms: null, detail: {} },
  { seq: 2, ts: '2026-09-04T09:12:01.410Z', stage: 'INGESTING', status: 'COMPLETED', message_zh: '8,000 条记录已固定，源哈希已计算', message_en: '8,000 records secured, source hash computed', elapsed_ms: 290, detail: { rows: 8000 } },
  { seq: 3, ts: '2026-09-04T09:12:01.412Z', stage: 'PROFILING', status: 'STARTED', message_zh: '开始列画像', message_en: 'Profiling columns', elapsed_ms: null, detail: {} },
  { seq: 4, ts: '2026-09-04T09:12:02.003Z', stage: 'PROFILING', status: 'COMPLETED', message_zh: '14 个字段已画像', message_en: '14 columns profiled', elapsed_ms: 591, detail: { columns: 14 } },
  { seq: 5, ts: '2026-09-04T09:12:02.005Z', stage: 'SENSITIVE_PREFLIGHT', status: 'COMPLETED', message_zh: '敏感预检完成：1 列被屏蔽，18 个单元格已掩码', message_en: 'Sensitive preflight: 1 column withheld, 18 cells masked', elapsed_ms: 44, detail: {} },
  { seq: 6, ts: '2026-09-04T09:12:02.010Z', stage: 'SEMANTIC_ANALYSIS', status: 'STARTED', message_zh: '向模型发送 city 列的聚合候选值（0 行）', message_en: 'Sending aggregated candidates for city to the model (0 rows)', elapsed_ms: null, detail: {} },
  { seq: 7, ts: '2026-09-04T09:12:05.842Z', stage: 'SEMANTIC_ANALYSIS', status: 'INFO', message_zh: '模型超时，已回退到确定性映射', message_en: 'Model timed out; fell back to deterministic mapping', elapsed_ms: 3_832, detail: {} },
  { seq: 8, ts: '2026-09-04T09:12:05.901Z', stage: 'DETECTING', status: 'FAILED', message_zh: '检测器 VAL-amount 抛出异常（示例）', message_en: 'Detector VAL-amount raised (sample)', elapsed_ms: 59, detail: {} },
  { seq: 9, ts: '2026-09-04T09:12:05.950Z', stage: 'REVIEW_REQUIRED', status: 'COMPLETED', message_zh: '9 个问题，其中 4 个阻断，等待人工处置', message_en: '9 findings, 4 blocking, awaiting human decisions', elapsed_ms: 4_830, detail: {} },
];

const sampleValidations: ValidationResult[] = [
  { check_id: 'SOURCE_IMMUTABLE', passed: true, observed: SAMPLE_HASH.slice(0, 10), expected: SAMPLE_HASH.slice(0, 10), message_zh: '源文件哈希未变化', message_en: 'Source hash unchanged' },
  { check_id: 'NO_UNAPPROVED_CELL_CHANGES', passed: true, observed: 347, expected: 347, message_zh: '变更单元格数与已批准动作范围一致', message_en: 'Changed cells match approved action scopes' },
  { check_id: 'ROW_RECONCILIATION', passed: false, observed: 7_811, expected: 7_812, message_zh: '可发布行数与对账结果相差 1（示例）', message_en: 'Eligible rows differ from reconciliation by 1 (sample)' },
];

const sampleLedger: AICallRecord = {
  call_id: 'call_01J8ZK9Q5P3W2XN4M6V7B8C9D0',
  run_id: 'run_sample',
  task: 'semantic',
  finding_id: 'SEM-city',
  provider: 'anthropic',
  model_requested: 'claude-opus-5',
  model_served: 'claude-opus-5',
  prompt_version: 'semantic-v3',
  input_hash: SAMPLE_HASH_2,
  output_hash: SAMPLE_HASH,
  request_bytes: 412,
  request_payload: { column: 'city', rows_sent: 0, candidate_counts: { 'Shang Hai': 120 } },
  response_payload: { mapping: { 'Shang Hai': '上海' }, abstained: false },
  input_tokens: 1_842,
  output_tokens: 236,
  cache_read_tokens: 1_500,
  latency_ms: 2_310,
  status: 'ok',
  grounding: { valid: true, reason_codes: [], affected_record_count: 212 },
  redaction: { rows_sent: 0, columns_withheld: ['customer_phone'], values_sent: 27, chars_sent: 412 },
  request_id: 'req_sample',
  created_at: '2026-09-04T09:12:04.000Z',
};

const rejectedLedger: AICallRecord = {
  ...sampleLedger,
  call_id: 'call_01J8ZK9Q5P3W2XN4M6V7B8C9D1',
  task: 'contract_draft',
  status: 'rejected_by_grounding',
  grounding: { valid: false, reason_codes: ['UNOBSERVED_VALUE', 'SENSITIVE_DOWNGRADE'], affected_record_count: 0 },
};

const sampleYaml = `id: ecommerce-orders
version: 1.0.0
title_zh: 电商订单发布契约
business_key: [order_id]
fields:
  order_id: { required: true, unique: true }
  customer_phone: { sensitive: true }
  city:
    canonical:
      上海: [上海市, Shanghai, SH]
    semantic: true
  order_date: { type: date, format: "%Y-%m-%d" }
`;

function Section({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-baseline gap-2">
        <h2 className="text-sm font-semibold">{title}</h2>
        {note ? <span className="text-xs text-muted-foreground">{note}</span> : null}
      </div>
      {children}
    </section>
  );
}

export default function KitPage() {
  const { t, language } = useLanguage();
  const [selected, setSelected] = useState<string | null>('city');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [yaml, setYaml] = useState(sampleYaml);

  const columnTable: DataTableColumn<ColumnProfile>[] = [
    { key: 'name', header: t('Column', '字段'), render: (row) => <span className="mono">{row.name}</span> },
    { key: 'inferred_type', header: t('Type', '类型'), render: (row) => label('inferred_type', row.inferred_type, language) },
    { key: 'null_rate', header: t('Non-null', '非空率'), render: (row) => <Bar value={1 - row.null_rate} /> },
    { key: 'distinct_count', header: t('Distinct', '唯一值'), align: 'right' },
    {
      key: 'top_values',
      header: t('Top values', 'Top 值'),
      render: (row) => (
        <span className="inline-flex flex-wrap gap-1.5">
          {row.top_values.map((tv) => (
            <span key={tv.value} className="inline-flex items-center gap-1">
              <MaskedValue value={tv.value} patternClass={tv.pattern_class} />
              <span className="text-[11px] text-muted-foreground">×{formatInt(tv.count)}</span>
            </span>
          ))}
        </span>
      ),
    },
    {
      key: 'contract_flags',
      header: t('Flags', '标记'),
      render: (row) => (
        <span className="inline-flex flex-wrap gap-1">
          {row.contract_flags.map((flag) => (
            <Pill key={flag} variant={flag === 'sensitive' ? 'blocker' : 'neutral'}>
              {label('contract_flag', flag, language)}
            </Pill>
          ))}
        </span>
      ),
    },
  ];

  const validationTable: DataTableColumn<ValidationResult>[] = [
    { key: 'check_id', header: t('Check', '检查'), render: (row) => label('validation', row.check_id, language) },
    {
      key: 'passed',
      header: t('Result', '结果'),
      render: (row) => <Pill variant={row.passed ? 'policy' : 'blocker'}>{row.passed ? t('Pass', '通过') : t('Fail', '未通过')}</Pill>,
    },
    { key: 'message', header: t('Message', '说明'), render: (row) => pick(language, row.message_zh, row.message_en) },
    { key: 'observed', header: t('Observed', '观测'), align: 'right', render: (row) => <span className="mono">{String(row.observed)}</span> },
    { key: 'expected', header: t('Expected', '期望'), align: 'right', render: (row) => <span className="mono">{String(row.expected)}</span> },
  ];

  const steps: StepperStep[] = [
    { id: '1', state: 'done', detail: t('8,000 records · 14 columns', '8,000 条记录 · 14 个字段') },
    { id: '2', state: 'done', detail: t('Contract ecommerce-orders@1.0.0', '契约 ecommerce-orders@1.0.0') },
    { id: '3', state: 'done', detail: t('9 findings · 4 blocking', '9 个问题 · 4 个阻断') },
    { id: '4', state: 'active', detail: t('3 unresolved', '3 项待处置') },
    { id: '5', state: 'locked', reason: t('Resolve every blocking finding first', '需先处置全部阻断问题') },
    { id: '6', state: 'locked', reason: t('Requires a dry run', '需先完成变更预演') },
    { id: '7', state: 'locked', reason: t('Requires apply and validation', '需先执行并通过验证') },
  ];

  return (
    <div className="data-dense mx-auto flex w-full max-w-6xl flex-col gap-8 px-4 py-6">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h1 className="text-base font-semibold">{t('Component kit', '组件库')}</h1>
          <p className="text-xs text-muted-foreground">
            {t(
              'Every value on this page is sample data (示例) for visual review. Product pages read from the API only.',
              '本页所有数值均为示例数据，仅用于视觉核对。产品页面只读取 API 数据。',
            )}
          </p>
        </div>
        <Pill variant="review">{t('Sample data', '示例数据')}</Pill>
      </header>

      <Section title="Pill" note={t('policy / review / blocker / ai / neutral / info', '策略 / 审查 / 阻断 / AI / 中性 / 信息')}>
        <div className="flex flex-wrap items-center gap-2">
          <Pill variant="policy">{t('Policy', '策略')}</Pill>
          <Pill variant="review">{t('Review', '审查')}</Pill>
          <Pill variant="blocker">{t('Blocker', '阻断')}</Pill>
          <Pill variant="ai">AI</Pill>
          <Pill variant="neutral">{t('Neutral', '中性')}</Pill>
          <Pill variant="info" dot>
            {t('Info', '信息')}
          </Pill>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {(labelKeys('lifecycle') as Lifecycle[]).map((value) => (
            <LifecyclePill key={value} value={value} />
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {(labelKeys('release_status') as ReleaseStatus[]).map((value) => (
            <ReleaseStatusPill key={value} value={value} />
          ))}
          {(labelKeys('risk') as RiskLevel[]).map((value) => (
            <RiskPill key={value} value={value} />
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {(labelKeys('authorization_mode') as AuthorizationMode[]).map((value) => (
            <AuthModePill key={value} value={value} />
          ))}
        </div>
      </Section>

      <Section title="HashChip · CopyButton">
        <div className="flex flex-wrap items-center gap-2">
          <HashChip value={SAMPLE_HASH} label={t('dataset', '数据集')} />
          <HashChip value={SAMPLE_HASH_2} label={t('contract', '契约')} />
          <HashChip value={SAMPLE_HASH} />
          <HashChip value={null} label={t('release', '发布')} />
          <CopyButton value={SAMPLE_HASH} />
          <CopyButton value={SAMPLE_HASH} label={t('Copy run id', '复制运行 ID')} size="md" />
        </div>
      </Section>

      <Section title="ProvenanceMark">
        <div className="flex flex-wrap items-center gap-3">
          <ProvenanceMark provenance={provenanceFromRecord(sampleLedger)} />
          <ProvenanceMark provenance={provenanceFromRecord(sampleLedger)} showModel />
          <ProvenanceMark provenance={provenanceFromRecord(rejectedLedger)} />
          <ProvenanceMark
            provenance={{
              provider: 'deterministic',
              status: 'fallback_deterministic',
              reason: t('Model timed out after 25 s; exact-normalisation mapping used instead.', '模型 25 秒超时，改用精确规范化映射。'),
            }}
          />
          <ProvenanceMark provenance={{ provider: 'verified-replay', status: 'ok' }} />
        </div>
      </Section>

      <Section title="MetricTile">
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
          {sampleMetrics.map((metric) => (
            <MetricTile key={metric.name} metric={metric} compareTo={metric.name === 'validity' ? 0.9712 : undefined} />
          ))}
        </div>
      </Section>

      <Section title="DataTable" note={t('click a row to select', '点击行以选中')}>
        <DataTable
          columns={columnTable}
          rows={sampleColumns}
          rowKey={(row) => row.name}
          selectedKey={selected}
          onRowClick={(row) => {
            setSelected(row.name);
            setDrawerOpen(true);
          }}
          maxHeight={260}
          ariaLabel={t('Column profiles (sample)', '列画像（示例）')}
        />
        <DataTable columns={validationTable} rows={sampleValidations} rowKey={(row) => row.check_id} />
        <DataTable
          columns={validationTable}
          rows={[]}
          rowKey={(row) => row.check_id}
          emptyTitle={t('No validations yet', '尚无验证结果')}
          emptyDescription={t('Validations stream in during apply.', '验证结果会在执行阶段逐条到达。')}
        />
      </Section>

      <Section title="Bar · MaskedValue">
        <div className="flex flex-wrap items-center gap-4">
          <Bar value={0.9976} />
          <Bar value={0.93} />
          <Bar value={0.61} />
          <Bar value={0.42} tone="ai" width={120} />
          <Bar value={null} />
        </div>
        <div className="flex flex-wrap items-center gap-4">
          <MaskedValue value="上海" />
          <MaskedValue value="••••@••••" patternClass="email" />
          <MaskedValue value="1••••••••••" patternClass="cn_mobile" />
          <MaskedValue value="" />
          <MaskedValue value="张三" masked />
        </div>
      </Section>

      <Section title="EventLog" note={t('compact and expanded', '紧凑与展开')}>
        <EventLog events={sampleEvents} mode="compact" transport="sse" live />
        <EventLog events={sampleEvents} mode="expanded" maxHeight={220} transport="polling" />
        <EventLog events={[]} mode="compact" />
      </Section>

      <Section title="Stepper · PanelSection · KeyValueList">
        <div className="grid gap-3 lg:grid-cols-[220px_minmax(0,1fr)]">
          <PanelSection title={t('Stages', '阶段')} bodyClassName="p-2">
            <Stepper steps={steps} onSelect={() => undefined} />
          </PanelSection>
          <PanelSection
            id="kit-integrity"
            title={t('Integrity', '完整性')}
            description={t('Hashes that must match across the run.', '整个运行过程中必须一致的哈希。')}
            actions={<CopyButton value={SAMPLE_HASH} label={t('Copy all', '全部复制')} />}
          >
            <KeyValueList
              columns={2}
              items={[
                { key: 'dataset', label: t('Dataset', '数据集'), value: <HashChip value={SAMPLE_HASH} /> },
                { key: 'contract', label: t('Contract', '契约'), value: <HashChip value={SAMPLE_HASH_2} /> },
                { key: 'scope', label: t('Scope', '评分范围'), value: <HashChip value={SAMPLE_HASH_2} /> },
                { key: 'actions', label: t('Action set', '动作集'), value: <HashChip value={null} /> },
                { key: 'records', label: t('Records', '记录数'), value: formatInt(8000), mono: true },
                { key: 'size', label: t('Source size', '源文件大小'), value: formatBytes(1_648_212), mono: true },
                { key: 'created', label: t('Created', '创建时间'), value: <span suppressHydrationWarning>{formatDateTime('2026-09-04T09:12:01Z', language)}</span>, mono: true },
                { key: 'elapsed', label: t('Pipeline time', '流水线耗时'), value: formatMs(4830), mono: true },
                { key: 'score', label: t('Overall score', '综合得分'), value: formatScore(0.9934), mono: true },
                { key: 'pct', label: t('Eligible', '可发布比例'), value: formatPct(0.9764), mono: true },
              ]}
            />
          </PanelSection>
        </div>
      </Section>

      <Section title="YamlEditor" note={t('editable and read-only', '可编辑与只读')}>
        <div className="grid gap-3 lg:grid-cols-2">
          <YamlEditor value={yaml} onChange={setYaml} minRows={10} />
          <YamlEditor value={sampleYaml} readOnly minRows={10} />
        </div>
      </Section>

      <Section title="InlineAlert · EmptyState">
        <div className="flex flex-col gap-2">
          <InlineAlert variant="info" title={t('Observational mode', '仅观测模式')}>
            {t('No contract was supplied; findings are observations and do not gate release.', '未提供契约；结果仅为观测，不判定发布资格。')}
          </InlineAlert>
          <InlineAlert variant="warning" title={t('Deterministic fallback', '确定性回退')}>
            {t('The model timed out; exact-normalisation mapping was used and is labelled as such.', '模型超时，已改用精确规范化映射并如实标注。')}
          </InlineAlert>
          <InlineAlert
            variant="error"
            title={t('Apply rejected (409)', '执行被拒绝（409）')}
            actions={
              <Button size="sm" variant="outline">
                {t('Reload run', '重新加载')}
              </Button>
            }
          >
            {t('run_revision is stale; reload the run before applying.', 'run_revision 已过期，请重新加载后再执行。')}
          </InlineAlert>
        </div>
        <EmptyState
          icon={<FileSearch />}
          title={t('No runs yet', '尚无运行记录')}
          description={t('Upload a CSV or start from a sample dataset.', '上传 CSV 或从样例数据开始。')}
          action={<Button size="sm">{t('Start analysis', '开始分析')}</Button>}
        />
      </Section>

      <Section title="Drawer · ConfirmDialog">
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => setDrawerOpen(true)}>
            {t('Open drawer', '打开抽屉')}
          </Button>
          <Button size="sm" onClick={() => setConfirmOpen(true)}>
            {t('Open confirm dialog', '打开确认对话框')}
          </Button>
        </div>
      </Section>

      <Drawer
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        title={`SEM-${selected ?? 'city'} · ${t('Semantic variants (sample)', '语义变体（示例）')}`}
        description={t('Row click from the table above opens this inspector.', '点击上方表格的行会打开此检查器。')}
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => setDrawerOpen(false)}>
              {t('Close', '关闭')}
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <RiskPill value="MEDIUM" />
            <AuthModePill value="HUMAN_APPROVAL_REQUIRED" />
            <ProvenanceMark provenance={provenanceFromRecord(sampleLedger)} showModel />
          </div>
          <KeyValueList
            items={[
              { key: 'col', label: t('Column', '字段'), value: 'city', mono: true },
              { key: 'records', label: t('Records', '记录数'), value: formatInt(212), mono: true },
              { key: 'cells', label: t('Cells', '单元格'), value: formatInt(212), mono: true },
            ]}
          />
          <DataTable
            columns={[
              { key: 'from', header: t('Observed', '观测值'), render: (r: { from: string; to: string; n: number }) => <MaskedValue value={r.from} /> },
              { key: 'to', header: t('Proposed target', '提议目标'), render: (r: { from: string; to: string; n: number }) => <MaskedValue value={r.to} /> },
              { key: 'n', header: t('Count', '数量'), align: 'right' },
            ]}
            rows={[
              { from: 'Shang Hai', to: '上海', n: 120 },
              { from: '上海 市', to: '上海', n: 62 },
              { from: '沪', to: '上海', n: 30 },
            ]}
            rowKey={(r) => r.from}
          />
        </div>
      </Drawer>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={t('Apply and validate', '应用并验证')}
        description={t('The source file is never modified; a candidate and a release artifact are produced.', '源文件不会被修改；将生成候选版本与发布版本。')}
        confirmLabel={t('Apply', '执行')}
        onConfirm={() => setConfirmOpen(false)}
      >
        <KeyValueList
          items={[
            { key: 'src', label: t('Source hash', '源哈希'), value: <HashChip value={SAMPLE_HASH} /> },
            { key: 'set', label: t('Action set', '动作集'), value: <HashChip value={SAMPLE_HASH_2} /> },
            { key: 'eligible', label: t('Eligible', '可发布'), value: formatInt(7_812), mono: true },
            { key: 'quarantined', label: t('Quarantined', '隔离'), value: formatInt(68), mono: true },
            { key: 'excluded', label: t('Excluded', '排除'), value: formatInt(120), mono: true },
          ]}
        />
      </ConfirmDialog>
    </div>
  );
}
