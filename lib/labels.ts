import { formatInt, humanize } from '@/lib/format';
import type { Language } from '@/lib/language';
import type { Finding } from '@/lib/types';

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
  | 'evidence_signal'
  | 'evidence_status'
  | 'authorization_source'
  | 'disposition'
  | 'contract_flag';

type Pair = readonly [zh: string, en: string];
type Table = Readonly<Record<string, Pair>>;

const lifecycle: Table = {
  QUEUED: ['排队中', 'Queued'],
  RUNNING: ['分析中', 'Running'],
  REVIEW_REQUIRED: ['需要人工确认', 'Review required'],
  OBSERVATIONAL: ['快速扫描完成', 'Observational'],
  DRY_RUN_READY: ['执行预览已生成', 'Dry run ready'],
  APPLIED: ['处理完成', 'Applied'],
  FAILED: ['失败', 'Failed'],
};

const releaseStatus: Table = {
  NOT_EVALUATED: ['尚未判定', 'Not evaluated'],
  BLOCKED: ['暂不可交付', 'Blocked'],
  CONDITIONAL_PASS: ['可交付（含隔离项）', 'Conditional pass'],
  PASS: ['可交付', 'Pass'],
};

const risk: Table = {
  LOW: ['低风险', 'Low'],
  MEDIUM: ['中风险', 'Medium'],
  HIGH: ['高风险', 'High'],
};

const authorizationMode: Table = {
  POLICY_AUTHORIZED: ['规则允许自动处理', 'Policy authorized'],
  HUMAN_APPROVAL_REQUIRED: ['需要人工确认', 'Human approval required'],
  QUARANTINE_ONLY: ['仅可隔离', 'Quarantine only'],
  FORBIDDEN: ['仅查看，不自动处理', 'Forbidden'],
};

const allowedAction: Table = {
  NORMALIZE_CATEGORY: ['统一类别写法', 'Normalize category'],
  STANDARDIZE_DATE_FORMAT: ['统一日期格式', 'Standardize date format'],
  EXCLUDE_EXACT_DUPLICATE_FROM_RELEASE: ['交付时排除重复副本', 'Exclude exact duplicates'],
  EXCLUDE_COLUMN_FROM_RELEASE: ['交付时不包含该字段', 'Exclude column from release'],
  QUARANTINE_RECORDS: ['隔离相关记录', 'Quarantine records'],
  FLAG_FOR_REVIEW: ['标记后续复核', 'Flag for review'],
};

const decisionOutcome: Table = {
  APPROVE_PROPOSAL: ['采用建议', 'Approve proposal'],
  QUARANTINE: ['隔离相关记录', 'Quarantine'],
  EXCLUDE: ['从交付数据中排除', 'Exclude'],
  FLAG_FOR_REVIEW: ['标记后续复核', 'Flag for review'],
  REJECT_PROPOSAL: ['不采用建议', 'Reject proposal'],
};

const aiStatus: Table = {
  ok: ['成功', 'OK'],
  abstained: ['暂不判断', 'Abstained'],
  rejected_by_grounding: ['建议未通过证据校验', 'Rejected by grounding'],
  refusal: ['未提供建议', 'Refusal'],
  timeout: ['超时', 'Timeout'],
  error: ['错误', 'Error'],
  fallback_deterministic: ['已改用规则结果', 'Deterministic fallback'],
  cached: ['复用已核验结果', 'Cached · last live call'],
};

const provider: Table = {
  anthropic: ['Anthropic', 'Anthropic'],
  deterministic: ['规则引擎', 'Deterministic'],
  'verified-replay': ['已核验结果', 'Verified replay'],
};

const eventStage: Table = {
  INGESTING: ['读取数据', 'Ingesting'],
  PROFILING: ['分析数据结构', 'Profiling'],
  DETECTING: ['查找问题', 'Detecting'],
  SENSITIVE_PREFLIGHT: ['检查敏感信息', 'Sensitive preflight'],
  SEMANTIC_ANALYSIS: ['判断语义', 'Semantic analysis'],
  REVIEW_REQUIRED: ['等待人工确认', 'Review required'],
  OBSERVATIONAL_READY: ['快速扫描完成', 'Observational ready'],
  CONTRACT_DRAFTING: ['生成发布规则草案', 'Contract drafting'],
  BRIEF_DRAFTING: ['生成交付摘要', 'Brief drafting'],
  DRY_RUN: ['生成执行预览', 'Dry run'],
  APPLY: ['执行并验证', 'Apply'],
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
  AMB: ['语义歧义', 'Ambiguous value'],
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
  '1': ['接收并分析', 'Ingest and profile'],
  '2': ['设置发布规则', 'Data contract'],
  '3': ['识别数据问题', 'Detection and semantics'],
  '4': ['确认处理方式', 'Human decisions'],
  '5': ['预览执行结果', 'Change dry run'],
  '6': ['执行并验证', 'Apply and validate'],
  '7': ['生成交付报告', 'Release report'],
};

const contractSource: Table = {
  uploaded: ['用户上传', 'Uploaded'],
  drafted: ['AI 草拟', 'Drafted'],
  sample: ['样例已配置', 'Sample'],
  baseline: ['未设置发布规则', 'Baseline'],
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

const evidenceSignal: Table = {
  ambiguity_registry: ['多义值检查', 'Ambiguity registry'],
  business_key_uniqueness: ['业务编号唯一性', 'Business key uniqueness'],
  canonical_glossary_match: ['标准词表匹配', 'Canonical glossary match'],
  code_cooccurrence_consistency: ['关联字段一致性', 'Code co-occurrence consistency'],
  contract_constraint: ['发布规则校验', 'Contract constraint'],
  contract_sensitive_declaration: ['敏感字段声明', 'Sensitive-field declaration'],
  distribution_stability: ['分布稳定性', 'Distribution stability'],
  grounding_validation: ['建议证据校验', 'Proposal grounding'],
  identical_payload: ['完整记录比对', 'Identical payload'],
  normalized_string_match: ['标准化文本匹配', 'Normalized string match'],
  safe_imputation_evidence: ['安全补全依据', 'Safe imputation evidence'],
  sensitive_pattern_preflight: ['敏感信息预检', 'Sensitive-pattern preflight'],
  unambiguous_date_parse: ['日期解析检查', 'Unambiguous date parse'],
};

const authorizationSource: Table = {
  POLICY: ['策略', 'Policy'],
  HUMAN: ['人工', 'Human'],
};

const disposition: Table = {
  OPEN: ['待处理', 'Open'],
  POLICY_AUTHORIZED: ['规则已授权', 'Policy authorized'],
  APPROVED: ['已确认', 'Approved'],
  QUARANTINED: ['已隔离', 'Quarantined'],
  EXCLUDED: ['已排除', 'Excluded'],
  FLAGGED: ['已标记复核', 'Flagged'],
  PROPOSAL_REJECTED: ['已不采用建议', 'Proposal rejected'],
  RESOLVED: ['已处理', 'Resolved'],
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
  evidence_signal: evidenceSignal,
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

/**
 * Product-facing finding copy. The report keeps the detector's exact bilingual wording for
 * audit/export; the interface uses these shorter Chinese sentences so a reviewer can scan the
 * problem before opening the technical evidence.
 */
export function findingDisplayTitle(finding: Finding, language: Language): string {
  if (language === 'en') return finding.title_en;
  const column = finding.column ? `「${finding.column}」` : '数据集';
  switch (finding.finding_type) {
    case 'EXACT_DUPLICATE':
      return '发现完全重复的记录';
    case 'BUSINESS_KEY_CONFLICT':
      return `${column} 存在编号相同但内容不同的记录`;
    case 'KNOWN_AMBIGUOUS_TOKEN':
      return `${column} 中有含义不明确的取值`;
    case 'CATEGORY_VARIANT':
      return `${column} 中有可以统一的写法`;
    case 'SEMANTIC_VARIANT':
      return finding.proposed_action ? `${column} 中有需要确认的相近表达` : `${column} 中有尚未识别的取值`;
    case 'SEMANTIC_CONFLICT':
      return `${column} 的语义建议与其他字段不一致`;
    case 'REQUIRED_FIELD_MISSING':
      return `${formatInt(finding.affected_record_count)} 条记录缺少 ${column}`;
    case 'FORMAT_INCONSISTENCY':
      return `${column} 的日期格式不一致`;
    case 'VALIDITY_VIOLATION':
      return `${formatInt(finding.affected_record_count)} 条记录的 ${column} 不符合规则`;
    case 'POTENTIAL_DIRECT_IDENTIFIER':
      return `${column} 中发现可能的敏感信息`;
    default:
      return finding.title_zh;
  }
}

export function findingDisplayExplanation(finding: Finding, language: Language): string {
  if (language === 'en') return finding.explanation_en;
  const count = formatInt(finding.affected_record_count);
  const column = finding.column ? `「${finding.column}」` : '该数据';
  switch (finding.finding_type) {
    case 'EXACT_DUPLICATE':
      return `${count} 条记录与更早出现的记录完全一致。处理时只会排除多余副本，第一条仍会保留。`;
    case 'BUSINESS_KEY_CONFLICT':
      return `${count} 条记录共用了相同编号，但其他内容不一致。系统不会猜测哪一条正确，需要先隔离确认。`;
    case 'KNOWN_AMBIGUOUS_TOKEN':
      return `${count} 条记录在 ${column} 中使用了可能对应多种含义的值。为避免误改，需要人工确认，目前只允许先隔离相关记录。`;
    case 'CATEGORY_VARIANT':
      return `${count} 条记录的 ${column} 与发布规则中的标准值明确对应，可以在不改变原意的前提下统一写法。`;
    case 'SEMANTIC_VARIANT':
      return finding.proposed_action ? `AI 根据允许值与本次数据的证据，为 ${count} 条记录给出了归一建议。建议已通过证据校验，但仍需要你确认后才会执行。` : `${column} 中的部分取值还无法安全对应到标准值，因此保持原样，等待人工确认。`;
    case 'SEMANTIC_CONFLICT':
      return `${count} 条记录的 ${column} 虽然有可能的标准写法，但与其他字段不一致。这些记录不会被自动修改。`;
    case 'REQUIRED_FIELD_MISSING':
      return `${count} 条记录缺少必须的 ${column}。系统不会猜测补全，可先隔离这些记录再交付其余数据。`;
    case 'FORMAT_INCONSISTENCY':
      return `${count} 条记录的 ${column} 使用了不同的日期写法。系统已确认这些值可以明确解析，统一格式后会再次验证。`;
    case 'VALIDITY_VIOLATION':
      return `${count} 条记录的 ${column} 超出了发布规则允许的范围。系统不会自动改写这些值，请选择隔离或标记复核。`;
    case 'POTENTIAL_DIRECT_IDENTIFIER':
      return `${column} 中有 ${formatInt(finding.affected_cell_count)} 个单元格符合敏感信息特征。页面已遮蔽原值，交付前需要排除该字段或隔离相关记录。`;
    default:
      return finding.explanation_zh;
  }
}

/** Ordered list of the seven workspace stages. */
export const STEPPER_STAGES = ['1', '2', '3', '4', '5', '6', '7'] as const;
export type StepperStageId = (typeof STEPPER_STAGES)[number];
