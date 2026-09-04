import { humanize } from '@/lib/format';
import type { Language } from '@/lib/language';

export type LabelKind =
  | 'lifecycle'
  | 'release_status'
  | 'risk'
  | 'authorization_mode'
  | 'allowed_action'
  | 'decision_outcome'
  | 'ai_status'
  | 'provider'
  | 'event_stage'
  | 'event_status'
  | 'metric'
  | 'validation'
  | 'finding_prefix'
  | 'inferred_type'
  | 'grounding_reason'
  | 'stepper_stage'
  | 'contract_source'
  | 'ai_task'
  | 'evidence_status'
  | 'authorization_source'
  | 'disposition'
  | 'contract_flag';

type Pair = readonly [zh: string, en: string];
type Table = Readonly<Record<string, Pair>>;

const lifecycle: Table = {
  QUEUED: ['排队中', 'Queued'],
  RUNNING: ['分析中', 'Running'],
  REVIEW_REQUIRED: ['待人工审查', 'Review required'],
  OBSERVATIONAL: ['仅观测', 'Observational'],
  DRY_RUN_READY: ['预演就绪', 'Dry run ready'],
  APPLIED: ['已执行', 'Applied'],
  FAILED: ['失败', 'Failed'],
};

const releaseStatus: Table = {
  NOT_EVALUATED: ['未评估', 'Not evaluated'],
  BLOCKED: ['已阻断', 'Blocked'],
  CONDITIONAL_PASS: ['有条件通过', 'Conditional pass'],
  PASS: ['通过', 'Pass'],
};

const risk: Table = {
  LOW: ['低风险', 'Low'],
  MEDIUM: ['中风险', 'Medium'],
  HIGH: ['高风险', 'High'],
};

const authorizationMode: Table = {
  POLICY_AUTHORIZED: ['策略授权', 'Policy authorized'],
  HUMAN_APPROVAL_REQUIRED: ['需人工批准', 'Human approval required'],
  QUARANTINE_ONLY: ['仅可隔离', 'Quarantine only'],
  FORBIDDEN: ['禁止自动处理', 'Forbidden'],
};

const allowedAction: Table = {
  NORMALIZE_CATEGORY: ['规范化类别', 'Normalize category'],
  STANDARDIZE_DATE_FORMAT: ['统一日期格式', 'Standardize date format'],
  EXCLUDE_EXACT_DUPLICATE_FROM_RELEASE: ['排除完全重复记录', 'Exclude exact duplicates'],
  EXCLUDE_COLUMN_FROM_RELEASE: ['从发布中排除字段', 'Exclude column from release'],
  QUARANTINE_RECORDS: ['隔离记录', 'Quarantine records'],
  FLAG_FOR_REVIEW: ['标记待审', 'Flag for review'],
};

const decisionOutcome: Table = {
  APPROVE_PROPOSAL: ['批准提议', 'Approve proposal'],
  QUARANTINE: ['隔离', 'Quarantine'],
  EXCLUDE: ['排除', 'Exclude'],
  FLAG_FOR_REVIEW: ['标记待审', 'Flag for review'],
  REJECT_PROPOSAL: ['拒绝提议', 'Reject proposal'],
};

const aiStatus: Table = {
  ok: ['成功', 'OK'],
  abstained: ['已弃权', 'Abstained'],
  rejected_by_grounding: ['被落地校验拦截', 'Rejected by grounding'],
  refusal: ['模型拒答', 'Refusal'],
  timeout: ['超时', 'Timeout'],
  error: ['错误', 'Error'],
  fallback_deterministic: ['确定性回退', 'Deterministic fallback'],
  cached: ['缓存 · 上次真实调用', 'Cached · last live call'],
};

const provider: Table = {
  anthropic: ['Anthropic', 'Anthropic'],
  deterministic: ['确定性引擎', 'Deterministic'],
  'verified-replay': ['已验证回放', 'Verified replay'],
};

const eventStage: Table = {
  INGESTING: ['接收', 'Ingesting'],
  PROFILING: ['画像', 'Profiling'],
  DETECTING: ['检测', 'Detecting'],
  SENSITIVE_PREFLIGHT: ['敏感预检', 'Sensitive preflight'],
  SEMANTIC_ANALYSIS: ['语义分析', 'Semantic analysis'],
  REVIEW_REQUIRED: ['待人工审查', 'Review required'],
  OBSERVATIONAL_READY: ['观测完成', 'Observational ready'],
  CONTRACT_DRAFTING: ['契约起草', 'Contract drafting'],
  BRIEF_DRAFTING: ['简报生成', 'Brief drafting'],
  DRY_RUN: ['预演', 'Dry run'],
  APPLY: ['执行', 'Apply'],
};

const eventStatus: Table = {
  STARTED: ['开始', 'Started'],
  COMPLETED: ['完成', 'Completed'],
  FAILED: ['失败', 'Failed'],
  INFO: ['信息', 'Info'],
};

const metric: Table = {
  completeness: ['完整性', 'Completeness'],
  validity: ['有效性', 'Validity'],
  consistency: ['一致性', 'Consistency'],
  uniqueness: ['唯一性', 'Uniqueness'],
  overall: ['综合得分', 'Overall'],
};

const validation: Table = {
  SOURCE_IMMUTABLE: ['源数据不可变', 'Source immutable'],
  SCOPE_STABLE: ['评分范围稳定', 'Scope stable'],
  EVALUATION_SCOPE_STABLE: ['评估范围稳定', 'Evaluation scope stable'],
  COMPLETENESS_NOT_IMPUTED: ['完整性未被填补', 'Completeness not imputed'],
  NO_UNAPPROVED_CELL_CHANGES: ['无未授权单元格变更', 'No unapproved cell changes'],
  CONFLICTS_UNCHANGED: ['冲突记录未改动', 'Conflicts unchanged'],
  QUARANTINE_EXCLUDED: ['隔离记录已排除', 'Quarantine excluded'],
  DUPLICATES_EXCLUDED: ['重复记录已排除', 'Duplicates excluded'],
  SENSITIVE_COLUMN_EXCLUDED: ['敏感字段已排除', 'Sensitive column excluded'],
  ROW_RECONCILIATION: ['行数对账一致', 'Row reconciliation'],
  FINDING_CONSERVATION: ['问题守恒', 'Finding conservation'],
  ACTION_SET_HASH_MATCH: ['动作集哈希一致', 'Action set hash match'],
  CHANGE_LEDGER_RECONCILES: ['变更账本对账一致', 'Change ledger reconciles'],
  MANIFEST_HASHES_RECOMPUTED: ['清单哈希已重算', 'Manifest hashes recomputed'],
};

const findingPrefix: Table = {
  DUP: ['重复', 'Duplicate'],
  CAT: ['类别别名', 'Category alias'],
  SEM: ['语义变体', 'Semantic variant'],
  AMB: ['多义值', 'Ambiguous value'],
  MISS: ['必填缺失', 'Missing required'],
  FMT: ['日期格式', 'Date format'],
  VAL: ['校验失败', 'Validation'],
  PHI: ['敏感信息', 'Sensitive data'],
};

const inferredType: Table = {
  integer: ['整数', 'Integer'],
  number: ['数值', 'Number'],
  date: ['日期', 'Date'],
  datetime: ['日期时间', 'Datetime'],
  boolean: ['布尔', 'Boolean'],
  string: ['文本', 'String'],
  empty: ['空列', 'Empty'],
};

const groundingReason: Table = {
  UNKNOWN_FINDING: ['引用了未知问题', 'Unknown finding'],
  UNKNOWN_COLUMN: ['引用了未知字段', 'Unknown column'],
  STALE_OR_UNKNOWN_INPUT: ['输入哈希过期或未知', 'Stale or unknown input'],
  HALLUCINATED_SOURCE_VALUE: ['源值并不存在', 'Hallucinated source value'],
  UNKNOWN_CANONICAL_TARGET: ['目标不在规范词表中', 'Unknown canonical target'],
  UNKNOWN_EVIDENCE_REFERENCE: ['证据引用不存在', 'Unknown evidence reference'],
  UNKNOWN_EVIDENCE: ['证据引用不存在', 'Unknown evidence reference'],
  AMBIGUITY_REGISTRY_HIT: ['命中多义词登记表', 'Ambiguity registry hit'],
  UNSUPPORTED_ACTION: ['动作不在允许列表', 'Unsupported action'],
  ABSTENTION_WITH_MAPPING: ['弃权却给出映射', 'Abstention with mapping'],
  UNOBSERVED_VALUE: ['值未在数据中观测到', 'Unobserved value'],
  TYPE_MISMATCH: ['类型与画像不符', 'Type mismatch'],
  SENSITIVE_DOWNGRADE: ['试图降低敏感级别', 'Sensitive downgrade'],
  UNKNOWN_FORMAT: ['格式未在数据中观测到', 'Unknown format'],
  UNVERIFIED_NUMBER: ['数字无法核实', 'Unverified number'],
  SCHEMA_VIOLATION: ['输出不符合结构化模式', 'Schema violation'],
  UNKNOWN_FACT: ['引用了不存在的事实编号', 'Unknown fact'],
};

const stepperStage: Table = {
  '1': ['接收与画像', 'Ingest and profile'],
  '2': ['数据契约', 'Data contract'],
  '3': ['检测与语义', 'Detection and semantics'],
  '4': ['人工处置', 'Human decisions'],
  '5': ['变更预演', 'Change dry run'],
  '6': ['执行与验证', 'Apply and validate'],
  '7': ['发布报告', 'Release report'],
};

const contractSource: Table = {
  uploaded: ['已上传', 'Uploaded'],
  drafted: ['AI 起草', 'Drafted'],
  sample: ['样例自带', 'Sample'],
  baseline: ['基线（无契约）', 'Baseline'],
};

const aiTask: Table = {
  semantic: ['语义映射', 'Semantic mapping'],
  contract_draft: ['契约起草', 'Contract draft'],
  brief: ['发布简报', 'Release brief'],
  redteam: ['红队模拟篡改', 'Red-team tamper'],
};

const evidenceStatus: Table = {
  PASS: ['通过', 'Pass'],
  FAIL: ['未通过', 'Fail'],
  NOT_APPLICABLE: ['不适用', 'N/A'],
};

const authorizationSource: Table = {
  POLICY: ['策略', 'Policy'],
  HUMAN: ['人工', 'Human'],
};

const disposition: Table = {
  OPEN: ['待处置', 'Open'],
  POLICY_AUTHORIZED: ['策略授权', 'Policy authorized'],
  APPROVED: ['已批准', 'Approved'],
  QUARANTINED: ['已隔离', 'Quarantined'],
  EXCLUDED: ['已排除', 'Excluded'],
  FLAGGED: ['已标记', 'Flagged'],
  PROPOSAL_REJECTED: ['提议已拒绝', 'Proposal rejected'],
  RESOLVED: ['已处置', 'Resolved'],
};

const contractFlag: Table = {
  required: ['必填', 'required'],
  unique: ['唯一', 'unique'],
  sensitive: ['敏感', 'sensitive'],
  canonical: ['规范词表', 'canonical'],
  allowed: ['闭合枚举', 'allowed'],
  date: ['日期', 'date'],
  semantic: ['语义', 'semantic'],
};

const tables: Readonly<Record<LabelKind, Table>> = {
  lifecycle,
  release_status: releaseStatus,
  risk,
  authorization_mode: authorizationMode,
  allowed_action: allowedAction,
  decision_outcome: decisionOutcome,
  ai_status: aiStatus,
  provider,
  event_stage: eventStage,
  event_status: eventStatus,
  metric,
  validation,
  finding_prefix: findingPrefix,
  inferred_type: inferredType,
  grounding_reason: groundingReason,
  stepper_stage: stepperStage,
  contract_source: contractSource,
  ai_task: aiTask,
  evidence_status: evidenceStatus,
  authorization_source: authorizationSource,
  disposition,
  contract_flag: contractFlag,
};

/**
 * Bilingual label lookup. Unknown values fall back to a humanised form of the token so a new
 * backend enum member never renders as a raw identifier.
 */
export function label(kind: LabelKind, value: string | null | undefined, language: Language): string {
  if (value === null || value === undefined || value === '') return '—';
  const pair = tables[kind][value];
  if (pair) return language === 'zh' ? pair[0] : pair[1];
  return humanize(value);
}

/** All known keys for a label kind, in declaration order. */
export function labelKeys(kind: LabelKind): string[] {
  return Object.keys(tables[kind]);
}

/** "SEM-city-CONFLICT" → "SEM"; used to derive a family label for any finding id. */
export function findingPrefixOf(findingId: string): string {
  const [prefix] = findingId.split('-');
  return prefix ?? findingId;
}

/** Family label for a finding id (e.g. "CAT-city" → 类别别名 / Category alias). */
export function findingFamilyLabel(findingId: string, language: Language): string {
  return label('finding_prefix', findingPrefixOf(findingId), language);
}

/** Ordered list of the seven workspace stages. */
export const STEPPER_STAGES = ['1', '2', '3', '4', '5', '6', '7'] as const;
export type StepperStageId = (typeof STEPPER_STAGES)[number];
