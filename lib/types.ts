// TypeScript mirror of the backend pydantic models (services/api/datapilot/contracts/models.py)
// and of the HTTP API shapes in docs/BUILD-SPEC.md §7. Keys stay snake_case on purpose.

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH';

export type AuthorizationMode =
  | 'POLICY_AUTHORIZED'
  | 'HUMAN_APPROVAL_REQUIRED'
  | 'QUARANTINE_ONLY'
  | 'FORBIDDEN';

export type ReleaseStatus = 'NOT_EVALUATED' | 'BLOCKED' | 'CONDITIONAL_PASS' | 'PASS';

export type AllowedAction =
  | 'NORMALIZE_CATEGORY'
  | 'STANDARDIZE_DATE_FORMAT'
  | 'EXCLUDE_EXACT_DUPLICATE_FROM_RELEASE'
  | 'EXCLUDE_COLUMN_FROM_RELEASE'
  | 'QUARANTINE_RECORDS'
  | 'FLAG_FOR_REVIEW';

export type DecisionOutcome =
  | 'APPROVE_PROPOSAL'
  | 'QUARANTINE'
  | 'EXCLUDE'
  | 'FLAG_FOR_REVIEW'
  | 'REJECT_PROPOSAL';

export type Lifecycle =
  | 'QUEUED'
  | 'RUNNING'
  | 'REVIEW_REQUIRED'
  | 'OBSERVATIONAL'
  | 'DRY_RUN_READY'
  | 'APPLIED'
  | 'FAILED';

export type ContractSource = 'uploaded' | 'drafted' | 'sample' | 'baseline';

export type AITask = 'semantic' | 'contract_draft' | 'brief' | 'redteam';

export type AIStatus =
  | 'ok'
  | 'abstained'
  | 'rejected_by_grounding'
  | 'refusal'
  | 'timeout'
  | 'error'
  | 'fallback_deterministic'
  /** Live call failed and the identical `input_hash` was served from the response cache (§5.2b). */
  | 'cached';

export type ProviderName = 'anthropic' | 'deterministic' | 'verified-replay';

export type EventStatus = 'STARTED' | 'COMPLETED' | 'FAILED' | 'INFO';

export type EvidenceStatus = 'PASS' | 'FAIL' | 'NOT_APPLICABLE';

export type InferredType =
  | 'integer'
  | 'number'
  | 'date'
  | 'datetime'
  | 'boolean'
  | 'string'
  | 'empty';

export type AuthorizationSource = 'POLICY' | 'HUMAN';

export type ContractDraftStatus = 'pending' | 'ready' | 'failed';

/** Pipeline stage names emitted in the event stream (spec §6). */
export type EventStage =
  | 'INGESTING'
  | 'PROFILING'
  | 'DETECTING'
  | 'SENSITIVE_PREFLIGHT'
  | 'SEMANTIC_ANALYSIS'
  | 'REVIEW_REQUIRED'
  | 'OBSERVATIONAL_READY'
  | 'CONTRACT_DRAFTING'
  | 'BRIEF_DRAFTING'
  | 'DRY_RUN'
  | 'APPLY';

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

export type MetricScore = {
  name: string;
  numerator: number;
  denominator: number;
  score: number | null;
  scope_zh: string;
  scope_en: string;
  applicable: boolean;
};

export type TopValue = {
  value: string;
  count: number;
  pattern_class: string | null;
};

export type FormatPattern = {
  pattern: string;
  count: number;
};

export type ColumnProfile = {
  name: string;
  inferred_type: InferredType;
  null_count: number;
  null_rate: number;
  distinct_count: number;
  top_values: TopValue[];
  min: string | null;
  max: string | null;
  max_length: number;
  format_patterns: FormatPattern[];
  sensitive_hit_count: number;
  contract_flags: string[];
};

/** Encoding detected on the uploaded bytes (§3.1). `dataset_hash` is always over the original bytes. */
export type SourceEncoding = 'utf-8' | 'utf-8-sig' | 'gb18030';

export type ProfileSummary = {
  dataset_hash: string;
  /** One of `SourceEncoding`; typed as string so a new backend value still parses. */
  source_encoding: string;
  record_count: number;
  column_count: number;
  scope_hash: string;
  evaluation_scope_hash: string;
  score_version: string;
  metrics: MetricScore[];
  overall_score: number | null;
};

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

export type EvidenceSignal = {
  signal: string;
  status: EvidenceStatus;
  explanation_zh: string;
  explanation_en: string;
  evidence_ref: string;
};

export type GroundingResult = {
  valid: boolean;
  reason_codes: string[];
  affected_record_count: number;
};

export type AIProposalSummary = {
  provider: ProviderName;
  model: string;
  prompt_version: string;
  input_hash: string;
  mapping: Record<string, string> | null;
  abstained: boolean;
  abstain_reason: string | null;
  grounding: GroundingResult;
  ledger_call_id: string | null;
};

export type Finding = {
  finding_id: string;
  finding_type: string;
  title: string;
  title_zh: string;
  title_en: string;
  explanation_zh: string;
  explanation_en: string;
  column: string | null;
  affected_record_count: number;
  affected_cell_count: number;
  risk_level: RiskLevel;
  blocking: boolean;
  authorization_mode: AuthorizationMode;
  proposed_action: AllowedAction | null;
  disposition: string;
  allowed_outcomes: DecisionOutcome[];
  evidence_signals: EvidenceSignal[];
  record_uids: string[];
  sample_record_uids: string[];
  details: Record<string, unknown>;
  proposal: AIProposalSummary | null;
};

export type ContractInfo = {
  id: string;
  version: string;
  hash: string;
  source: ContractSource;
  field_count: number;
};

export type SensitivePreflight = {
  columns_withheld: string[];
  cells_masked: number;
};

export type RunReport = {
  schema_version: string;
  engine_version: string;
  fixture_version: string | null;
  synthetic: boolean;
  profile: ProfileSummary;
  column_profiles: ColumnProfile[];
  contract: ContractInfo;
  sensitive_preflight: SensitivePreflight;
  findings: Finding[];
  release_status: ReleaseStatus;
  finding_outcome_counts: Record<string, number>;
  warnings: string[];
  warnings_zh: string[];
  warnings_en: string[];
  timings_ms: Record<string, number>;
  run_revision: number;
};

// ---------------------------------------------------------------------------
// Governance
// ---------------------------------------------------------------------------

export type HumanDecision = {
  finding_id: string;
  outcome: DecisionOutcome;
  reason: string | null;
  run_revision: number;
};

type ActionBase = {
  finding_id: string;
  authorization_source: AuthorizationSource;
  authorization_ref: string;
};

export type NormalizeCategoryAction = ActionBase & {
  action_type: 'NORMALIZE_CATEGORY';
  column: string;
  mapping: Record<string, string>;
  record_uids: string[];
};

export type StandardizeDateFormatAction = ActionBase & {
  action_type: 'STANDARDIZE_DATE_FORMAT';
  column: string;
  source_format: string;
  target_format: string;
  record_uids: string[];
};

export type ExcludeExactDuplicateAction = ActionBase & {
  action_type: 'EXCLUDE_EXACT_DUPLICATE_FROM_RELEASE';
  record_uids: string[];
};

export type QuarantineRecordsAction = ActionBase & {
  action_type: 'QUARANTINE_RECORDS';
  record_uids: string[];
};

export type ExcludeColumnAction = ActionBase & {
  action_type: 'EXCLUDE_COLUMN_FROM_RELEASE';
  column: string;
};

export type FlagForReviewAction = ActionBase & {
  action_type: 'FLAG_FOR_REVIEW';
  record_uids: string[];
};

export type ApprovedAction =
  | NormalizeCategoryAction
  | StandardizeDateFormatAction
  | ExcludeExactDuplicateAction
  | QuarantineRecordsAction
  | ExcludeColumnAction
  | FlagForReviewAction;

export type DryRunReport = {
  run_revision: number;
  source_artifact_hash: string;
  approved_action_set_hash: string;
  actions: ApprovedAction[];
  finding_dispositions: Record<string, string>;
  affected_record_count: number;
  affected_cell_count: number;
  eligible_record_count: number;
  quarantined_record_count: number;
  excluded_record_count: number;
  flagged_record_count: number;
  excluded_columns: string[];
  blocking_unresolved: string[];
  /** sha256 of the canonical JSON of the human decisions the dry run was built from (§4). */
  decision_set_hash: string;
  status: 'NOT_APPLIED';
};

export type ChangePreviewItem = {
  record_uid: string;
  display_key: string;
  column: string;
  before: string;
  after: string;
  finding_id: string;
  action_type: AllowedAction;
};

export type ChangePreview = {
  changes: ChangePreviewItem[];
  totals: Record<string, number>;
  truncated: boolean;
};

export type ValidationResult = {
  check_id: string;
  passed: boolean;
  observed: unknown;
  expected: unknown;
  message_zh: string;
  message_en: string;
};

export type ReleaseManifest = {
  source_artifact_hash: string;
  candidate_artifact_hash: string;
  release_artifact_hash: string;
  policy_pack_hash: string;
  contract_hash: string;
  decision_set_hash: string;
  /** sha256 of `changes.jsonl` (cell-level change ledger, §4). */
  change_ledger_hash: string;
  engine_version: string;
  score_version: string;
  scope_hash: string;
  total_source_records: number;
  eligible_record_count: number;
  quarantined_record_uids: string[];
  excluded_record_uids: string[];
  flagged_record_uids: string[];
  excluded_columns: string[];
  finding_outcome_counts: Record<string, number>;
  validation_summary: { passed: number; failed: number };
  release_status: ReleaseStatus;
  ai_call_count: number;
  ai_provider: ProviderName;
  /** finding_id → ledger input_hash, linking each executed proposal to its request. */
  ai_input_hashes: Record<string, string>;
};

export type ExecutionResult = {
  baseline_profile: ProfileSummary;
  candidate_profile: ProfileSummary;
  dry_run: DryRunReport;
  validations: ValidationResult[];
  release_manifest: ReleaseManifest;
};

// ---------------------------------------------------------------------------
// Runs, events, AI
// ---------------------------------------------------------------------------

export type RunSummary = {
  run_id: string;
  created_at: string;
  source_name: string;
  sample_id: string | null;
  record_count: number | null;
  column_count: number | null;
  lifecycle: Lifecycle;
  release_status: ReleaseStatus | null;
  contract_source: ContractSource | null;
  run_revision: number;
};

export type RunEvent = {
  seq: number;
  ts: string;
  /** One of `EventStage`; typed as string so unknown future stages still parse. */
  stage: string;
  status: EventStatus;
  message_zh: string;
  message_en: string;
  elapsed_ms: number | null;
  detail: Record<string, unknown>;
};

export type RejectedRule = {
  field: string;
  rule: string;
  reason_code: string;
  detail_zh: string;
  detail_en: string;
};

export type ContractDraftResult = {
  status: ContractDraftStatus;
  draft_yaml: string | null;
  accepted_rules: Record<string, unknown>[];
  rejected_rules: RejectedRule[];
  ledger_call_id: string | null;
  error: string | null;
};

export type ReleaseBriefClaim = {
  text_zh: string;
  text_en: string;
  fact_ids: string[];
  verified: boolean;
  reason: string | null;
};

export type ReleaseBrief = {
  status: string;
  summary_zh: string;
  summary_en: string;
  claims: ReleaseBriefClaim[];
  verified_count: number;
  total_count: number;
  ledger_call_id: string | null;
};

export type RedactionSummary = {
  rows_sent: number;
  columns_withheld: string[];
  values_sent: number;
  chars_sent: number;
};

export type AICallRecord = {
  call_id: string;
  run_id: string;
  task: AITask;
  /** Set for `semantic` and `redteam` calls; null for run-level tasks. */
  finding_id: string | null;
  provider: ProviderName;
  model_requested: string;
  model_served: string | null;
  prompt_version: string;
  input_hash: string;
  output_hash: string | null;
  /** Byte length of the serialized `request_payload`. */
  request_bytes: number;
  /** The exact redacted JSON object that was sent (safe by construction, shown verbatim). */
  request_payload: Record<string, unknown> | null;
  /** The structured JSON the model returned, or the deterministic result. */
  response_payload: Record<string, unknown> | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  latency_ms: number;
  status: AIStatus;
  grounding: GroundingResult | null;
  redaction: RedactionSummary;
  request_id: string | null;
  created_at: string;
};

export type ContractView = {
  yaml: string;
  parsed: Record<string, unknown>;
  hash: string;
  source: ContractSource;
};

export type RunDetail = {
  run_id: string;
  lifecycle: Lifecycle;
  source_name: string;
  sample_id: string | null;
  created_at: string;
  run_revision: number;
  report: RunReport | null;
  contract: ContractView | null;
  decisions: Record<string, HumanDecision>;
  dry_run: DryRunReport | null;
  preview: ChangePreview | null;
  execution: ExecutionResult | null;
  brief: ReleaseBrief | null;
  error: string | null;
  /** Present when the run was created by `POST /v1/runs/{id}/replay`. */
  parent_run_id?: string | null;
};

export type SampleInfo = {
  id: string;
  title_zh: string;
  title_en: string;
  description_zh: string;
  description_en: string;
  rows: number;
  columns: number;
  has_contract: boolean;
  tags: string[];
};

// ---------------------------------------------------------------------------
// HTTP API shapes (spec §7)
// ---------------------------------------------------------------------------

export type RunCreated = {
  run_id: string;
  lifecycle: Lifecycle;
  run_revision: number;
};

export type HealthInfo = {
  status: string;
  engine_version: string;
  ai: {
    mode: string;
    provider: ProviderName;
    model: string;
    available: boolean;
  };
  samples: number;
};

export type ApiErrorBody = {
  error: {
    code: string;
    message_zh: string;
    message_en: string;
    retryable: boolean;
    correlation_id: string;
    /** Governance 409 bodies carry the mismatching values side by side (§4). */
    observed?: unknown;
    expected?: unknown;
  };
};

/** Alias kept for readers who expect the pydantic model name. */
export type ApiError = ApiErrorBody;

export type FindingRecords = {
  columns: string[];
  rows: string[][];
  masked_columns: string[];
};

export type DecisionInput = {
  finding_id: string;
  outcome: DecisionOutcome;
  reason: string | null;
};

export type DecisionsResponse = {
  decisions: Record<string, HumanDecision>;
  unresolved: string[];
};

export type DryRunResponse = {
  dry_run: DryRunReport;
  preview: ChangePreview;
};

export type ApplyRequest = {
  run_revision: number;
  approved_action_set_hash: string;
  idempotency_key: string;
};

export type ContractDraftStarted = {
  status: ContractDraftStatus;
};

/** `POST /v1/runs/{id}/replay` */
export type ReplayCreated = RunCreated & {
  parent_run_id: string;
};

/** `DELETE /v1/runs?older_than_minutes=N` */
export type CleanupResult = {
  deleted: number;
};

export type ArtifactName =
  | 'release.csv'
  | 'candidate.csv'
  | 'release-manifest.json'
  | 'changes.jsonl'
  | 'ai-ledger.jsonl'
  | 'audit-bundle.json';

/** `GET /v1/runs/{id}/artifacts` row. `role` is a backend-provided description of the file's purpose. */
export type ArtifactInfo = {
  name: string;
  role: string;
  bytes: number;
  sha256: string;
  modified_at: string;
};

/** `GET /v1/runs/{id}/verify` and `python -m datapilot verify` (§4). */
export type VerifyReport = {
  ok: boolean;
  checks: ValidationResult[];
};

/** Red-team harness cases (§5.6). Only `LIVE_INJECTION` calls the model. */
export type RedteamCase =
  | 'HALLUCINATED_SOURCE_VALUE'
  | 'UNKNOWN_CANONICAL_TARGET'
  | 'UNKNOWN_EVIDENCE_REFERENCE'
  | 'UNSUPPORTED_ACTION'
  | 'STALE_OR_UNKNOWN_INPUT'
  | 'ABSTENTION_WITH_MAPPING'
  | 'AMBIGUITY_REGISTRY_HIT'
  | 'LIVE_INJECTION'
  | 'TIMEOUT';

export const REDTEAM_CASES: readonly RedteamCase[] = [
  'HALLUCINATED_SOURCE_VALUE',
  'UNKNOWN_CANONICAL_TARGET',
  'UNKNOWN_EVIDENCE_REFERENCE',
  'UNSUPPORTED_ACTION',
  'STALE_OR_UNKNOWN_INPUT',
  'ABSTENTION_WITH_MAPPING',
  'AMBIGUITY_REGISTRY_HIT',
  'LIVE_INJECTION',
  'TIMEOUT',
];

/** `POST /v1/runs/{id}/findings/{fid}/redteam` response. Proposals are raw dicts (a tampered one may not validate). */
export type RedteamResult = {
  case: RedteamCase;
  original_proposal: Record<string, unknown> | null;
  tampered_proposal: Record<string, unknown> | null;
  grounding: GroundingResult;
  ledger_call_id: string | null;
  /** Backend verdict label (schema_rejected | grounding_rejected | grounding_passed | ledger status). */
  status?: string;
};

export type GroundingReasonGloss = {
  code: string;
  zh: string;
  en: string;
};

/** `GET /v1/ai/contract` — what the running backend actually does, read from code (§5.6). */
export type AiContract = {
  provider: ProviderName;
  model: string;
  prompt_versions: Record<string, string>;
  system_prompts: Record<string, string>;
  output_schemas: Record<string, unknown>;
  effort: Record<string, string>;
  max_tokens: Record<string, number>;
  timeout_seconds: Record<string, number>;
  max_calls_per_run: number;
  visible_to_model: string[];
  never_visible: string[];
  /** Action types the model may propose; `null` means "no proposal (abstain)". */
  allowed_proposals: (AllowedAction | null)[];
  grounding_reason_codes: GroundingReasonGloss[];
  /** Lets the browser verify its SHA-256 implementation: sha256(utf8(json)) must equal `sha256`. */
  canonical_test_vector: { json: string; sha256: string };
};

/** `POST /v1/runs/{id}/tamper-test`: in-memory execute against a flipped byte; nothing is written. */
export type TamperTestResult = ExecutionResult & { written: false };

/** Alias of `ReplayCreated` kept for readers of the console context. */
export type ReplayStarted = ReplayCreated;

/** `POST /v1/runs/{id}/findings/{fid}/semantic` (§5.2b). */
export type SemanticRerunResult = {
  finding: Finding;
  ledger_call_id: string | null;
};

