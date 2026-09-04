'use client';

import type { ReactNode } from 'react';

import { CopyButton, DataTable, KeyValueList, PanelSection, Pill, YamlEditor, type DataTableColumn } from '@/components/datapilot';
import { useHealth } from '@/lib/api';
import { formatInt } from '@/lib/format';
import { useLanguage, type Language } from '@/lib/language';
import { label, labelKeys } from '@/lib/labels';
import type { AllowedAction } from '@/lib/types';
import { cn } from '@/lib/utils';

type T = (en: string, zh: string) => string;

// ---------------------------------------------------------------------------
// Invariants (README "Truth boundaries" + spec §0 non-negotiable 5)
// ---------------------------------------------------------------------------

type Invariant = { key: string; term: [zh: string, en: string]; body: [zh: string, en: string] };

const INVARIANTS: Invariant[] = [
  {
    key: 'source',
    term: ['源 CSV 不可变', 'Source CSV is immutable'],
    body: [
      'dataset_hash 对上传的原始字节计算；执行后 SOURCE_IMMUTABLE 门禁重新计算并比对，任何字节改动都会阻断发布。',
      'dataset_hash is computed over the uploaded bytes; after apply the SOURCE_IMMUTABLE gate recomputes and compares it, so any byte change blocks release.',
    ],
  },
  {
    key: 'uid',
    term: ['record_uid 派生规则固定', 'record_uid derivation is fixed'],
    body: [
      'record_uid = sha256(dataset_hash:ordinal)[:24]，只依赖源文件哈希与行序号，与单元格内容无关，跨运行可比。',
      'record_uid = sha256(dataset_hash:ordinal)[:24]; it depends only on the source hash and row ordinal, never on cell content, so it is comparable across runs.',
    ],
  },
  {
    key: 'score',
    term: ['质量分范围固定', 'Fixed score scope'],
    body: [
      '基线与候选使用同一记录范围和评估范围（scope_hash / evaluation_scope_hash）；隔离与排除改变发布成员资格，不改变分母。',
      'Baseline and candidate share one record scope and evaluation scope (scope_hash / evaluation_scope_hash); quarantine and exclusion change release membership, not the denominator.',
    ],
  },
  {
    key: 'actions',
    term: ['动作类型化且有允许列表', 'Actions are typed and allowlisted'],
    body: [
      '执行器只接受六种动作；模型只能提议 NORMALIZE_CATEGORY 或不提议。不在列表内的动作在模式校验层被拒绝。',
      'The executor accepts six action types only; the model may propose NORMALIZE_CATEGORY or nothing. Anything else is rejected at schema validation.',
    ],
  },
  {
    key: 'manifest',
    term: ['清单以哈希链记录', 'Manifests are hash-chained'],
    body: [
      '源 → 契约 → 动作集 → 处置 → 候选 → 发布 → 变更账本，每一环都有 sha256，可离线用 verify 重算。',
      'source → contract → action set → decisions → candidate → release → change ledger, each with a sha256 that verify can recompute offline.',
    ],
  },
  {
    key: 'idempotent',
    term: ['执行幂等', 'Apply is idempotent'],
    body: [
      'apply 必须携带 run_revision、approved_action_set_hash 与 idempotency_key；任一过期返回 409，重复键返回已存储结果。',
      'apply must carry run_revision, approved_action_set_hash and an idempotency_key; a stale value returns 409 and a repeated key returns the stored result.',
    ],
  },
  {
    key: 'atomic',
    term: ['写入原子', 'Writes are atomic'],
    body: [
      '每个工件先写临时文件再重命名；磁盘是唯一真相，服务重启后运行状态从目录恢复。',
      'Every artifact is written to a temporary file and renamed; disk is the only truth and run state is recovered from the directory after a restart.',
    ],
  },
  {
    key: 'no-write',
    term: ['模型没有写权限，也不产出代码', 'The model has no write access and produces no code'],
    body: [
      '模型永远拿不到 dataframe 写权限，永远不产生可执行代码；它只返回结构化 JSON 提议。',
      'The model never receives dataframe write access and never produces executable code; it returns structured JSON proposals only.',
    ],
  },
  {
    key: 'proposal',
    term: ['提议不是动作', 'A proposal is not an action'],
    body: ['提议必须经策略授权或人工批准才会进入动作集。', 'A proposal enters the action set only after policy authorization or human approval.'],
  },
  {
    key: 'separate',
    term: ['质量分与发布状态分离', 'Quality score and release status are separate'],
    body: [
      '高分不等于可发布；一个阻断性问题未处置，发布状态就是 BLOCKED。',
      'A high score does not mean releasable; one unresolved blocking finding keeps release status BLOCKED.',
    ],
  },
  {
    key: 'replay',
    term: ['回放必须标注', 'Replay is always labelled'],
    body: ['离线回放带有明确标签，永远不被呈现为实时模型调用。', 'The offline replay carries an explicit label and is never presented as a live model run.'],
  },
  {
    key: 'heuristic',
    term: ['敏感数据检测是保守启发式', 'Sensitive-data detection is a conservative heuristic'],
    body: ['它不是合规声明；命中只产生计数与模式类别，原始值不会出现在任何报告、事件或 AI 载荷中。', 'It is not a compliance claim; hits yield counts and pattern classes only, and raw values never appear in any report, event or AI payload.'],
  },
];

// ---------------------------------------------------------------------------
// AI boundary diagram (inline SVG, theme tokens only)
// ---------------------------------------------------------------------------

type Node = { id: string; zh: string; en: string; sub_zh: string; sub_en: string; tone: 'default' | 'ai' | 'policy' | 'review' };

const NODES: Node[] = [
  { id: 'data', zh: '数据', en: 'Data', sub_zh: '源 CSV · 不可变', sub_en: 'Source CSV · immutable', tone: 'default' },
  { id: 'redact', zh: '脱敏聚合', en: 'Redaction', sub_zh: '值计数 · 0 行', sub_en: 'Value counts · 0 rows', tone: 'default' },
  { id: 'model', zh: '模型', en: 'Model', sub_zh: 'JSON schema 输出', sub_en: 'JSON-schema output', tone: 'ai' },
  { id: 'ground', zh: '接地校验', en: 'Grounding', sub_zh: '来源 ⊆ 观测 · 目标 ⊆ 词表', sub_en: 'sources ⊆ observed · targets ⊆ vocab', tone: 'default' },
  { id: 'policy', zh: '策略', en: 'Policy', sub_zh: '契约 auto_authorization', sub_en: 'Contract auto_authorization', tone: 'policy' },
  { id: 'human', zh: '人工', en: 'Human', sub_zh: '高风险拍板', sub_en: 'Decides high risk', tone: 'review' },
  { id: 'exec', zh: '确定性执行器', en: 'Executor', sub_zh: '类型化允许动作', sub_en: 'Typed allowlisted actions', tone: 'policy' },
  { id: 'validate', zh: '验证', en: 'Validation', sub_zh: '门禁 · 哈希清单', sub_en: 'Gates · hashed manifest', tone: 'default' },
  { id: 'verify', zh: '复核', en: 'Verify', sub_zh: '离线重算每个哈希', sub_en: 'Recompute every hash offline', tone: 'default' },
];

const NODE_W = 116;
const NODE_H = 40;
const GAP = 22;
const PAD_X = 12;
const TOP = 44;
const SVG_W = PAD_X * 2 + NODES.length * NODE_W + (NODES.length - 1) * GAP;
const SVG_H = 128;

function toneStyle(tone: Node['tone']): { fill: string; stroke: string; text: string } {
  switch (tone) {
    case 'ai':
      return { fill: 'var(--ai-tint)', stroke: 'var(--ai)', text: 'var(--ai)' };
    case 'policy':
      return { fill: 'var(--policy-tint)', stroke: 'var(--policy)', text: 'var(--policy)' };
    case 'review':
      return { fill: 'var(--review-tint)', stroke: 'var(--review)', text: 'var(--review)' };
    default:
      return { fill: 'var(--card)', stroke: 'var(--border)', text: 'var(--foreground)' };
  }
}

function BoundaryDiagram({ language }: { language: Language }) {
  const zh = language === 'zh';
  const modelIndex = NODES.findIndex((n) => n.id === 'model');
  const modelX = PAD_X + modelIndex * (NODE_W + GAP);
  return (
    <div className="overflow-x-auto">
      <svg
        viewBox={`0 0 ${SVG_W} ${SVG_H}`}
        width={SVG_W}
        height={SVG_H}
        className="block min-w-full"
        aria-labelledby="engine-boundary-title"
        style={{ fontFamily: 'var(--font-sans)' }}
      >
        <title id="engine-boundary-title">{zh ? 'AI 边界：数据到复核的流程' : 'AI boundary: flow from data to verify'}</title>
        <defs>
          <marker id="engine-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,0.5 L7.5,4 L0,7.5 Z" fill="var(--muted-foreground)" />
          </marker>
        </defs>
        {/* Dashed frame around the only stage that talks to the model. */}
        <rect
          x={modelX - 8}
          y={TOP - 26}
          width={NODE_W + 16}
          height={NODE_H + 34}
          rx={8}
          fill="none"
          stroke="var(--ai)"
          strokeDasharray="4 3"
          strokeWidth={1}
        />
        <text x={modelX + NODE_W / 2} y={TOP - 13} textAnchor="middle" fontSize={10.5} fill="var(--ai)">
          {zh ? 'AI 边界 · 只读 · 无执行权' : 'AI boundary · read-only · no execution'}
        </text>
        {NODES.map((node, index) => {
          const x = PAD_X + index * (NODE_W + GAP);
          const style = toneStyle(node.tone);
          const next = index < NODES.length - 1;
          return (
            <g key={node.id}>
              <rect x={x} y={TOP} width={NODE_W} height={NODE_H} rx={6} fill={style.fill} stroke={style.stroke} strokeWidth={1} />
              <text x={x + NODE_W / 2} y={TOP + NODE_H / 2 + 4.5} textAnchor="middle" fontSize={12.5} fontWeight={600} fill={style.text}>
                {zh ? node.zh : node.en}
              </text>
              <text x={x + NODE_W / 2} y={TOP + NODE_H + 22} textAnchor="middle" fontSize={10.5} fill="var(--muted-foreground)">
                {zh ? node.sub_zh : node.sub_en}
              </text>
              {next ? (
                <line
                  x1={x + NODE_W + 2}
                  y1={TOP + NODE_H / 2}
                  x2={x + NODE_W + GAP - 2}
                  y2={TOP + NODE_H / 2}
                  stroke="var(--muted-foreground)"
                  strokeWidth={1}
                  markerEnd="url(#engine-arrow)"
                />
              ) : null}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Static tables
// ---------------------------------------------------------------------------

type ActionRow = {
  action: AllowedAction;
  authorizer_zh: string;
  authorizer_en: string;
  findings: string;
  effect_zh: string;
  effect_en: string;
};

const ACTION_ROWS: ActionRow[] = [
  {
    action: 'NORMALIZE_CATEGORY',
    authorizer_zh: '策略（契约 category_normalization 为真时的精确别名）或人工（语义提议需人工批准）',
    authorizer_en: 'Policy (exact aliases when the contract sets category_normalization) or human (semantic proposals need approval)',
    findings: 'CAT-<col> · SEM-<col>',
    effect_zh: '把单元格值改写为规范目标；范围 = 提议或词表命中的记录',
    effect_en: 'Rewrites cell values to the canonical target; scope = records hit by the proposal or glossary',
  },
  {
    action: 'STANDARDIZE_DATE_FORMAT',
    authorizer_zh: '策略（契约 date_standardization 为真且存在契约）；无契约时禁止，仅观测',
    authorizer_en: 'Policy (contract sets date_standardization and a contract exists); forbidden and observational without one',
    findings: 'FMT-<col>',
    effect_zh: '将 accept_formats 命中的值改写为声明格式',
    effect_en: 'Rewrites values matching accept_formats into the declared format',
  },
  {
    action: 'EXCLUDE_EXACT_DUPLICATE_FROM_RELEASE',
    authorizer_zh: '策略（契约 exact_duplicate_exclusion 为真），否则人工',
    authorizer_en: 'Policy (contract sets exact_duplicate_exclusion), otherwise human',
    findings: 'DUP-EXACT',
    effect_zh: '多余的完全重复行不进入发布文件；不改任何单元格',
    effect_en: 'Surplus identical rows leave the release file; no cell changes',
  },
  {
    action: 'EXCLUDE_COLUMN_FROM_RELEASE',
    authorizer_zh: '仅人工（敏感字段整列排除）',
    authorizer_en: 'Human only (whole sensitive column excluded)',
    findings: 'PHI-<col>',
    effect_zh: '整列从发布文件移除，记录在清单 excluded_columns',
    effect_en: 'The column is removed from the release file and recorded in manifest excluded_columns',
  },
  {
    action: 'QUARANTINE_RECORDS',
    authorizer_zh: '仅人工；QUARANTINE_ONLY 类发现只有这一种结果',
    authorizer_en: 'Human only; the sole outcome for QUARANTINE_ONLY findings',
    findings: 'DUP-KEY · AMB · MISS · SEM-*-CONFLICT · VAL · SEM（隔离）',
    effect_zh: '记录留在候选集但不进入发布；record_uid 写入清单',
    effect_en: 'Records stay in the candidate set but leave the release; record_uids go to the manifest',
  },
  {
    action: 'FLAG_FOR_REVIEW',
    authorizer_zh: '仅人工',
    authorizer_en: 'Human only',
    findings: 'VAL-<col>',
    effect_zh: '不改数据、不改成员资格；record_uid 记入清单 flagged_record_uids',
    effect_en: 'No data or membership change; record_uids recorded in manifest flagged_record_uids',
  },
];

const VALIDATION_NOTES: Record<string, [zh: string, en: string]> = {
  SOURCE_IMMUTABLE: ['重算源文件 sha256 并与 report.dataset_hash 比对', 'Recompute the source sha256 and compare with report.dataset_hash'],
  SCOPE_STABLE: ['候选的 scope_hash 与基线一致', 'Candidate scope_hash equals the baseline'],
  EVALUATION_SCOPE_STABLE: ['候选的 evaluation_scope_hash 与基线一致', 'Candidate evaluation_scope_hash equals the baseline'],
  COMPLETENESS_NOT_IMPUTED: ['必填字段的非空分子未变化，没有填补', 'Required-field numerators are unchanged; nothing was imputed'],
  NO_UNAPPROVED_CELL_CHANGES: ['源与候选逐格对比，变更集合 = 已批准动作范围的并集', 'Cell-wise diff of source vs candidate equals the union of approved action scopes'],
  CONFLICTS_UNCHANGED: ['每个 SEM-*-CONFLICT 的记录在受影响列上未被改动', 'Records of every SEM-*-CONFLICT finding are untouched in the affected column'],
  QUARANTINE_EXCLUDED: ['隔离的 record_uid 不出现在发布文件中', 'Quarantined record_uids are absent from the release file'],
  DUPLICATES_EXCLUDED: ['多余的重复行不出现在发布文件中', 'Surplus duplicate rows are absent from the release file'],
  SENSITIVE_COLUMN_EXCLUDED: ['被排除的敏感列不出现在发布文件表头', 'Excluded sensitive columns are absent from the release header'],
  ROW_RECONCILIATION: ['总记录 = 可发布 + 隔离 + 排除', 'total = eligible + quarantined + excluded'],
  FINDING_CONSERVATION: ['每个发现都有处置，没有凭空消失', 'Every finding has a disposition; none disappears'],
  ACTION_SET_HASH_MATCH: ['执行的动作集哈希与批准时一致', 'The executed action-set hash equals the approved one'],
  CHANGE_LEDGER_RECONCILES: ['账本单元格记录数 = affected_cell_count；成员记录数 = 隔离 + 排除 + 标记', 'Ledger cell records = affected_cell_count; membership records = quarantined + excluded + flagged'],
  MANIFEST_HASHES_RECOMPUTED: ['候选、发布、账本文件的 sha256 重算后与清单一致', 'Recomputed sha256 of candidate, release and ledger files match the manifest'],
};

const GROUNDING_TASKS: Record<string, string[]> = {
  UNKNOWN_FINDING: ['semantic'],
  UNKNOWN_COLUMN: ['semantic', 'contract_draft'],
  STALE_OR_UNKNOWN_INPUT: ['semantic'],
  HALLUCINATED_SOURCE_VALUE: ['semantic'],
  UNKNOWN_CANONICAL_TARGET: ['semantic'],
  UNKNOWN_EVIDENCE_REFERENCE: ['semantic'],
  UNKNOWN_EVIDENCE: ['contract_draft'],
  AMBIGUITY_REGISTRY_HIT: ['semantic'],
  UNSUPPORTED_ACTION: ['semantic'],
  ABSTENTION_WITH_MAPPING: ['semantic'],
  UNOBSERVED_VALUE: ['contract_draft'],
  TYPE_MISMATCH: ['contract_draft'],
  SENSITIVE_DOWNGRADE: ['contract_draft'],
  UNKNOWN_FORMAT: ['contract_draft'],
  UNVERIFIED_NUMBER: ['brief'],
};

const CONTRACT_EXAMPLE = `id: ecommerce-orders
version: 1.0.0
title_zh: 电商订单发布契约
title_en: E-commerce orders release contract

score:
  version: dq-1.0
  weights: { completeness: 0.30, validity: 0.25, consistency: 0.25, uniqueness: 0.20 }

business_key: [order_id]

fields:
  order_id:       { required: true, unique: true }
  customer_phone: { sensitive: true }
  city:
    canonical:
      上海: [上海市, Shanghai, SH]
      北京: [北京市, Beijing, BJ]
    allowed: [上海, 北京, 深圳, 苏州, 杭州]
    semantic: true
  order_date: { type: date, format: "%Y-%m-%d", accept_formats: ["%d/%m/%Y", "%Y/%m/%d"] }
  status:     { required: true, allowed: [paid, shipped, refunded, cancelled] }
  amount:     { type: number, min: 0 }

ambiguity_registry:
  city: [SZ]

auto_authorization:
  exact_duplicate_exclusion: true
  category_normalization: true
  date_standardization: true
`;

type Adr = { id: string; file: string; title_zh: string; title_en: string; status_zh: string; status_en: string; points: [zh: string, en: string][] };

const ADRS: Adr[] = [
  {
    id: 'ADR 0001',
    file: 'docs/adr/0001-ai-cannot-execute-code.md',
    title_zh: 'AI 不能执行代码',
    title_en: 'AI cannot execute code',
    status_zh: '已接受',
    status_en: 'Accepted',
    points: [
      ['语义模型只能返回严格的、带证据链接的提议，动作名必须来自允许列表。', 'Semantic models may return strict, evidence-linked proposals using an allowlisted action name.'],
      ['模型没有 dataframe、文件系统、数据库、网络、Python、SQL 或执行器的访问权。', 'They have no dataframe, filesystem, database, network, Python, SQL, or executor access.'],
      ['后端接地校验在策略评估之前重新计算受影响范围。', 'Backend grounding validation recomputes affected scope before policy evaluation.'],
    ],
  },
  {
    id: 'ADR 0002',
    file: 'docs/adr/0002-fixed-score-scope.md',
    title_zh: '固定的质量分范围',
    title_en: 'Fixed quality score scope',
    status_zh: '已接受',
    status_en: 'Accepted',
    points: [
      ['基线与候选的质量分使用同一记录范围与评估范围。', 'Baseline and candidate quality use the same record and evaluation scope.'],
      ['隔离与发布排除影响发布成员资格，不影响质量分的分母。', 'Quarantine and release exclusion affect release membership, not the quality denominator.'],
      ['发布就绪度与质量分分开报告。', 'Release readiness is reported separately from quality.'],
    ],
  },
];

type GateRow = { command: string; zh: string; en: string };

const GATE_ROWS: GateRow[] = [
  { command: '.venv/bin/pytest', zh: '后端测试：契约翻译、引擎与样例、治理与验证、AI 接地与脱敏、API 全流程', en: 'Backend tests: contract translation, engine and samples, governance and validations, AI grounding and redaction, API flows' },
  { command: '.venv/bin/ruff check services tests conftest.py', zh: 'Python 静态检查', en: 'Python lint' },
  { command: '.venv/bin/mypy services/api/datapilot', zh: 'Python 类型检查', en: 'Python type check' },
  { command: 'npm run lint', zh: '前端 oxlint（类型感知）', en: 'Frontend oxlint (type-aware)' },
  { command: 'npm run build', zh: 'vinext 生产构建', en: 'vinext production build' },
];

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

function Column({ title, items, tone }: { title: string; items: string[]; tone: 'policy' | 'blocker' }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className={cn('text-xs font-semibold', tone === 'policy' ? 'text-policy' : 'text-blocker')}>{title}</div>
      <ul className="data-dense flex flex-col gap-1">
        {items.map((item) => (
          <li key={item} className="flex items-baseline gap-2">
            <span aria-hidden="true" className={cn('mt-1.5 size-1.5 shrink-0 rounded-full', tone === 'policy' ? 'bg-policy' : 'bg-blocker')} />
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Mono({ children }: { children: ReactNode }) {
  return <span className="mono text-xs">{children}</span>;
}

function taskPills(code: string, language: Language): ReactNode {
  const tasks = GROUNDING_TASKS[code];
  if (!tasks) return <span className="text-muted-foreground">—</span>;
  return (
    <span className="inline-flex flex-wrap gap-1">
      {tasks.map((task) => (
        <Pill key={task} variant="neutral">
          {label('ai_task', task, language)}
        </Pill>
      ))}
    </span>
  );
}

export default function EnginePage() {
  const { t, language } = useLanguage();
  const { health, error, loading } = useHealth();
  const zh = language === 'zh';
  const tt: T = t;

  const liveItems = [
    {
      key: 'engine',
      label: t('Engine version', '引擎版本'),
      value: health ? <Mono>{health.engine_version}</Mono> : <span className="text-muted-foreground">—</span>,
    },
    {
      key: 'provider',
      label: t('AI provider', 'AI 提供方'),
      value: health ? (
        <span className="inline-flex items-center gap-1.5">
          <span className={cn('pill', health.ai.provider === 'anthropic' && health.ai.available ? 'pill-ai' : 'pill-neutral')}>
            {health.ai.provider === 'anthropic' && health.ai.available ? 'AI' : t('Deterministic', '确定性')}
          </span>
          {label('provider', health.ai.provider, language)}
        </span>
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
    },
    {
      key: 'model',
      label: t('Model', '模型'),
      value: health ? <Mono>{health.ai.model}</Mono> : <span className="text-muted-foreground">—</span>,
    },
    {
      key: 'mode',
      label: t('AI mode', 'AI 模式'),
      value: health ? (
        <span className="inline-flex items-center gap-1.5">
          <Mono>{health.ai.mode}</Mono>
          <span className="text-muted-foreground">{health.ai.available ? t('available', '可用') : t('unavailable', '不可用')}</span>
        </span>
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
    },
    {
      key: 'samples',
      label: t('Samples registered', '已注册样例'),
      value: health ? <Mono>{formatInt(health.samples)}</Mono> : <span className="text-muted-foreground">—</span>,
    },
  ];

  const actionColumns: DataTableColumn<ActionRow>[] = [
    { key: 'action', header: t('Action', '动作'), render: (row) => <Mono>{row.action}</Mono> },
    { key: 'meaning', header: t('Meaning', '含义'), render: (row) => label('allowed_action', row.action, language) },
    { key: 'authorizer', header: t('Who may authorize', '谁可授权'), render: (row) => (zh ? row.authorizer_zh : row.authorizer_en) },
    { key: 'findings', header: t('Findings', '对应发现'), render: (row) => <Mono>{row.findings}</Mono> },
    { key: 'effect', header: t('Data effect', '数据影响'), render: (row) => (zh ? row.effect_zh : row.effect_en) },
  ];

  const validationRows = labelKeys('validation').map((id) => ({ id }));
  const validationColumns: DataTableColumn<{ id: string }>[] = [
    { key: 'id', header: 'check_id', render: (row) => <Mono>{row.id}</Mono> },
    { key: 'label', header: t('Gate', '门禁'), render: (row) => label('validation', row.id, language) },
    {
      key: 'note',
      header: t('What it compares', '比对内容'),
      render: (row) => {
        const note = VALIDATION_NOTES[row.id];
        return note ? (zh ? note[0] : note[1]) : <span className="text-muted-foreground">—</span>;
      },
    },
  ];

  const groundingRows = labelKeys('grounding_reason').map((code) => ({ code }));
  const groundingColumns: DataTableColumn<{ code: string }>[] = [
    { key: 'code', header: t('Reason code', '原因码'), render: (row) => <Mono>{row.code}</Mono> },
    { key: 'gloss', header: t('Meaning', '含义'), render: (row) => label('grounding_reason', row.code, language) },
    { key: 'task', header: t('Task', '任务'), render: (row) => taskPills(row.code, language) },
  ];

  const gateColumns: DataTableColumn<GateRow>[] = [
    {
      key: 'command',
      header: t('Command', '命令'),
      render: (row) => (
        <span className="inline-flex items-center gap-1.5">
          <Mono>{row.command}</Mono>
          <CopyButton value={row.command} />
        </span>
      ),
    },
    { key: 'what', header: t('What it runs', '检查内容'), render: (row) => (zh ? row.zh : row.en) },
  ];

  return (
    <div className="mx-auto flex w-full max-w-[1600px] flex-col gap-4 px-4 py-4 lg:px-6">
      <header className="flex flex-col gap-0.5">
        <h1 className="text-base font-semibold leading-6">{t('About the engine', '关于引擎')}</h1>
        <p className="text-[13px] leading-5 text-muted-foreground">
          {t(
            'What the engine promises, where the model is allowed, and which gates a release must pass. Live values below come from GET /health.',
            '引擎承诺什么、模型被允许到哪一步、发布必须通过哪些门禁。下方实时值来自 GET /health。',
          )}
        </p>
      </header>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <PanelSection
          id="invariants"
          title={t('Invariants', '不变量')}
          description={t('From the README truth boundaries and the v0.2 non-negotiables.', '来自 README 的真实边界与 v0.2 的不可协商项。')}
        >
          <dl className="data-dense grid gap-x-6 gap-y-3 md:grid-cols-2">
            {INVARIANTS.map((item) => (
              <div key={item.key} className="flex flex-col gap-0.5 border-l-2 border-border pl-3">
                <dt className="font-semibold">{zh ? item.term[0] : item.term[1]}</dt>
                <dd className="text-muted-foreground">{zh ? item.body[0] : item.body[1]}</dd>
              </div>
            ))}
          </dl>
        </PanelSection>

        <PanelSection
          id="live"
          title={t('Running instance', '当前实例')}
          description={
            loading
              ? 'GET /health …'
              : error
                ? `${error.code} · ${error.localized(language)}`
                : t('Refreshed every 15 s.', '每 15 秒刷新。')
          }
        >
          <KeyValueList items={liveItems} />
          <div className="mt-3 text-[11px] leading-4 text-muted-foreground">
            {t(
              'The AI budget is bounded at 8 calls per run; beyond that the engine falls back to deterministic behaviour and records the reason in the ledger.',
              'AI 预算上限为每次运行 8 次调用；超出后引擎回退为确定性行为，并把原因写入账本。',
            )}
          </div>
        </PanelSection>
      </div>

      <PanelSection
        id="boundary"
        title={t('AI boundary', 'AI 边界')}
        description={t(
          'The model is one read-only stage between redaction and grounding. It proposes; it never touches rows, files or the executor.',
          '模型只是脱敏与接地校验之间的一个只读环节。它负责提议，永远不接触行数据、文件或执行器。',
        )}
        bodyClassName="flex flex-col gap-4 p-3"
      >
        <BoundaryDiagram language={language} />
        <div className="grid gap-4 md:grid-cols-2">
          <Column
            tone="policy"
            title={t('Visible to the model', '模型可见')}
            items={[
              tt('Candidate value counts (≤ 30 values, ≤ 64 chars each)', '候选值计数（≤ 30 个值，每个 ≤ 64 字符）'),
              tt('Canonical vocabulary from the contract', '契约中的规范词表'),
              tt('Evidence references', '证据引用'),
              tt('Ambiguity tokens', '多义词登记'),
              tt('Column profiles without sensitive values', '不含敏感值的列画像'),
              tt('Named numeric facts (for the release brief)', '命名数值事实（用于发布简报）'),
            ]}
          />
          <Column
            tone="blocker"
            title={t('Never visible', '永不可见')}
            items={[
              tt('Rows', '行数据'),
              tt('record_uids', 'record_uid'),
              tt('Sensitive column values', '敏感字段的值'),
              tt("Other columns' values", '其他字段的值'),
              tt('File names and paths', '文件名与路径'),
            ]}
          />
        </div>
        <div className="text-[11px] leading-4 text-muted-foreground">
          {t(
            'The model may propose NORMALIZE_CATEGORY or nothing. Every response passes a deterministic grounding validator before it is shown; rejected proposals are kept in the ledger with their reason codes.',
            '模型只能提议 NORMALIZE_CATEGORY 或不提议。每个响应在展示前都要通过确定性接地校验；被拒绝的提议连同原因码保留在账本中。',
          )}
        </div>
      </PanelSection>

      <PanelSection
        id="actions"
        title={t('Allowed actions', '允许的动作')}
        description={t('The complete allowlist. There is no seventh action.', '完整允许列表，不存在第七种动作。')}
        flush
      >
        <DataTable columns={actionColumns} rows={ACTION_ROWS} rowKey={(row) => row.action} className="rounded-none border-0" ariaLabel={t('Allowed actions', '允许的动作')} />
      </PanelSection>

      <div className="grid gap-4 xl:grid-cols-2">
        <PanelSection
          id="gates"
          title={t('Validation gates', '验证门禁')}
          description={t('Every gate runs on each apply; one failure sets release status to BLOCKED.', '每次执行都会跑完全部门禁；任一失败即把发布状态置为 BLOCKED。')}
          flush
        >
          <DataTable columns={validationColumns} rows={validationRows} rowKey={(row) => row.id} className="rounded-none border-0" ariaLabel={t('Validation gates', '验证门禁')} />
        </PanelSection>

        <PanelSection
          id="grounding"
          title={t('Grounding reason codes', '接地原因码')}
          description={t('Why a model output can be rejected, by task.', '模型输出可能被拒绝的原因，按任务列出。')}
          flush
        >
          <DataTable columns={groundingColumns} rows={groundingRows} rowKey={(row) => row.code} className="rounded-none border-0" ariaLabel={t('Grounding reason codes', '接地原因码')} />
        </PanelSection>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <PanelSection
          id="contract"
          title={t('Data Contract v2', '数据契约 v2')}
          description={t(
            'The only place business meaning comes from. Without one the engine is observational only. Abbreviated example.',
            '业务含义唯一的来源。没有契约时引擎仅做观测。以下为节选示例。',
          )}
          actions={<CopyButton value={CONTRACT_EXAMPLE} label={t('Copy YAML', '复制 YAML')} />}
        >
          <YamlEditor value={CONTRACT_EXAMPLE} readOnly minRows={8} maxHeight={520} ariaLabel={t('Contract example', '契约示例')} />
          <div className="mt-2 text-[11px] leading-4 text-muted-foreground">
            {t(
              'Field options: required, unique, sensitive, type, format, accept_formats, allowed, canonical, semantic, consistent_with, min, max, max_length, pattern. v1 policy files are translated on load.',
              '字段选项：required、unique、sensitive、type、format、accept_formats、allowed、canonical、semantic、consistent_with、min、max、max_length、pattern。v1 policy 文件在加载时自动翻译。',
            )}
          </div>
        </PanelSection>

        <div className="flex flex-col gap-4">
          <PanelSection id="adr" title={t('Architecture decisions', '架构决策记录')} description={t('Summaries of docs/adr.', 'docs/adr 的摘要。')}>
            <ol className="flex flex-col gap-3">
              {ADRS.map((adr) => (
                <li key={adr.id} className="flex flex-col gap-1">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <Mono>{adr.id}</Mono>
                    <span className="text-[13px] font-semibold">{zh ? adr.title_zh : adr.title_en}</span>
                    <Pill variant="policy">{zh ? adr.status_zh : adr.status_en}</Pill>
                  </div>
                  <ul className="data-dense flex list-disc flex-col gap-0.5 pl-5 text-muted-foreground">
                    {adr.points.map((point) => (
                      <li key={point[1]}>{zh ? point[0] : point[1]}</li>
                    ))}
                  </ul>
                  <div className="mono text-[11px] text-muted-foreground">{adr.file}</div>
                </li>
              ))}
            </ol>
          </PanelSection>

          <PanelSection
            id="quality-gate"
            title={t('Quality gate', '质量门')}
            description={t('make test runs these in order and stops at the first failure.', 'make test 按顺序执行以下命令，任一失败即停止。')}
            flush
          >
            <DataTable columns={gateColumns} rows={GATE_ROWS} rowKey={(row) => row.command} className="rounded-none border-0" ariaLabel={t('Quality gate', '质量门')} />
          </PanelSection>
        </div>
      </div>
    </div>
  );
}
