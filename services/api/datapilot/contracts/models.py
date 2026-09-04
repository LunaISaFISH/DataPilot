"""Pydantic strict models shared by the engine, governance, AI layer, storage and HTTP API.

Every human-facing string produced by the backend is bilingual (``*_zh`` / ``*_en``).
Models are strict (``strict=True, extra="forbid"``); enum fields that must accept plain
strings from JSON bodies or from ``meta.json`` dictionaries opt out with ``Field(strict=False)``.
"""

from __future__ import annotations

from enum import StrEnum
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class StrictModel(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")


# --------------------------------------------------------------------------------------
# Enums
# --------------------------------------------------------------------------------------


class RiskLevel(StrEnum):
    LOW = "LOW"
    MEDIUM = "MEDIUM"
    HIGH = "HIGH"


class AuthorizationMode(StrEnum):
    POLICY_AUTHORIZED = "POLICY_AUTHORIZED"
    HUMAN_APPROVAL_REQUIRED = "HUMAN_APPROVAL_REQUIRED"
    QUARANTINE_ONLY = "QUARANTINE_ONLY"
    FORBIDDEN = "FORBIDDEN"


class ReleaseStatus(StrEnum):
    NOT_EVALUATED = "NOT_EVALUATED"
    BLOCKED = "BLOCKED"
    CONDITIONAL_PASS = "CONDITIONAL_PASS"
    PASS = "PASS"


class AllowedAction(StrEnum):
    NORMALIZE_CATEGORY = "NORMALIZE_CATEGORY"
    STANDARDIZE_DATE_FORMAT = "STANDARDIZE_DATE_FORMAT"
    EXCLUDE_EXACT_DUPLICATE_FROM_RELEASE = "EXCLUDE_EXACT_DUPLICATE_FROM_RELEASE"
    EXCLUDE_COLUMN_FROM_RELEASE = "EXCLUDE_COLUMN_FROM_RELEASE"
    QUARANTINE_RECORDS = "QUARANTINE_RECORDS"
    FLAG_FOR_REVIEW = "FLAG_FOR_REVIEW"


class DecisionOutcome(StrEnum):
    APPROVE_PROPOSAL = "APPROVE_PROPOSAL"
    QUARANTINE = "QUARANTINE"
    EXCLUDE = "EXCLUDE"
    FLAG_FOR_REVIEW = "FLAG_FOR_REVIEW"
    REJECT_PROPOSAL = "REJECT_PROPOSAL"


class Lifecycle(StrEnum):
    QUEUED = "QUEUED"
    RUNNING = "RUNNING"
    REVIEW_REQUIRED = "REVIEW_REQUIRED"
    OBSERVATIONAL = "OBSERVATIONAL"
    DRY_RUN_READY = "DRY_RUN_READY"
    APPLIED = "APPLIED"
    FAILED = "FAILED"


class ContractSource(StrEnum):
    UPLOADED = "uploaded"
    DRAFTED = "drafted"
    SAMPLE = "sample"
    BASELINE = "baseline"


class AITask(StrEnum):
    SEMANTIC = "semantic"
    CONTRACT_DRAFT = "contract_draft"
    BRIEF = "brief"
    REDTEAM = "redteam"


class AIStatus(StrEnum):
    OK = "ok"
    ABSTAINED = "abstained"
    REJECTED_BY_GROUNDING = "rejected_by_grounding"
    REFUSAL = "refusal"
    TIMEOUT = "timeout"
    ERROR = "error"
    FALLBACK_DETERMINISTIC = "fallback_deterministic"
    CACHED = "cached"


class ProviderName(StrEnum):
    ANTHROPIC = "anthropic"
    DETERMINISTIC = "deterministic"
    VERIFIED_REPLAY = "verified-replay"


class EventStatus(StrEnum):
    STARTED = "STARTED"
    COMPLETED = "COMPLETED"
    FAILED = "FAILED"
    INFO = "INFO"


InferredType = Literal["integer", "number", "date", "datetime", "boolean", "string", "empty"]
ContractFlag = Literal[
    "required", "unique", "sensitive", "canonical", "allowed", "date", "semantic"
]
DraftStatus = Literal["pending", "ready", "failed"]


# --------------------------------------------------------------------------------------
# Profiling
# --------------------------------------------------------------------------------------


class MetricScore(StrictModel):
    name: str
    numerator: int = Field(ge=0)
    denominator: int = Field(ge=0)
    score: float | None
    scope_zh: str
    scope_en: str
    applicable: bool


class TopValue(StrictModel):
    value: str
    count: int = Field(ge=0)
    pattern_class: str | None = None


class FormatPattern(StrictModel):
    pattern: str
    count: int = Field(ge=0)


class ColumnProfile(StrictModel):
    name: str
    inferred_type: InferredType
    null_count: int = Field(ge=0)
    null_rate: float = Field(ge=0.0, le=1.0)
    distinct_count: int = Field(ge=0)
    top_values: list[TopValue] = Field(max_length=5)
    min: str | None
    max: str | None
    max_length: int = Field(ge=0)
    format_patterns: list[FormatPattern]
    sensitive_hit_count: int = Field(ge=0)
    contract_flags: list[ContractFlag]


class ProfileSummary(StrictModel):
    dataset_hash: str
    record_count: int = Field(ge=0)
    column_count: int = Field(ge=0)
    scope_hash: str
    evaluation_scope_hash: str
    score_version: str
    metrics: list[MetricScore]
    overall_score: float | None
    source_encoding: str = "utf-8"


# --------------------------------------------------------------------------------------
# Findings and AI proposal summaries
# --------------------------------------------------------------------------------------


class EvidenceSignal(StrictModel):
    signal: str
    status: Literal["PASS", "FAIL", "NOT_APPLICABLE"]
    explanation_zh: str
    explanation_en: str
    evidence_ref: str


class GroundingResult(StrictModel):
    valid: bool
    reason_codes: list[str]
    affected_record_count: int = Field(default=0, ge=0)


class AIProposalSummary(StrictModel):
    provider: ProviderName = Field(strict=False)
    model: str
    prompt_version: str
    input_hash: str
    mapping: dict[str, str] | None
    abstained: bool
    abstain_reason: str | None
    grounding: GroundingResult
    ledger_call_id: str | None


class Finding(StrictModel):
    finding_id: str
    finding_type: str
    title_zh: str
    title_en: str
    explanation_zh: str
    explanation_en: str
    column: str | None
    affected_record_count: int = Field(ge=0)
    affected_cell_count: int = Field(ge=0)
    risk_level: RiskLevel
    blocking: bool
    authorization_mode: AuthorizationMode
    proposed_action: AllowedAction | None
    allowed_outcomes: list[DecisionOutcome]
    disposition: str
    evidence_signals: list[EvidenceSignal]
    record_uids: list[str]
    sample_record_uids: list[str] = Field(max_length=20)
    details: dict[str, Any]
    proposal: AIProposalSummary | None


class ContractInfo(StrictModel):
    id: str
    version: str
    hash: str
    source: ContractSource = Field(strict=False)
    field_count: int = Field(ge=0)


class SensitivePreflight(StrictModel):
    columns_withheld: list[str]
    cells_masked: int = Field(ge=0)


class RunReport(StrictModel):
    schema_version: Literal["2.0"]
    engine_version: str
    fixture_version: str | None
    synthetic: bool
    profile: ProfileSummary
    column_profiles: list[ColumnProfile]
    contract: ContractInfo
    sensitive_preflight: SensitivePreflight
    findings: list[Finding]
    release_status: ReleaseStatus
    finding_outcome_counts: dict[str, int]
    timings_ms: dict[str, int]
    warnings_zh: list[str]
    warnings_en: list[str]
    run_revision: int = Field(ge=1)


# --------------------------------------------------------------------------------------
# Decisions and approved actions
# --------------------------------------------------------------------------------------


class HumanDecision(StrictModel):
    finding_id: str
    outcome: DecisionOutcome = Field(strict=False)
    reason: str | None = None
    run_revision: int = Field(ge=1)


class NormalizeCategoryAction(StrictModel):
    action_type: Literal["NORMALIZE_CATEGORY"]
    finding_id: str
    column: str
    mapping: dict[str, str]
    record_uids: list[str]
    authorization_source: Literal["POLICY", "HUMAN"]
    authorization_ref: str


class StandardizeDateAction(StrictModel):
    action_type: Literal["STANDARDIZE_DATE_FORMAT"]
    finding_id: str
    column: str
    source_format: str
    target_format: str
    record_uids: list[str]
    authorization_source: Literal["POLICY", "HUMAN"]
    authorization_ref: str


class ExcludeDuplicatesAction(StrictModel):
    action_type: Literal["EXCLUDE_EXACT_DUPLICATE_FROM_RELEASE"]
    finding_id: str
    record_uids: list[str]
    authorization_source: Literal["POLICY", "HUMAN"]
    authorization_ref: str


class QuarantineAction(StrictModel):
    action_type: Literal["QUARANTINE_RECORDS"]
    finding_id: str
    record_uids: list[str]
    authorization_source: Literal["HUMAN"]
    authorization_ref: str


class ExcludeColumnAction(StrictModel):
    action_type: Literal["EXCLUDE_COLUMN_FROM_RELEASE"]
    finding_id: str
    column: str
    authorization_source: Literal["HUMAN"]
    authorization_ref: str


class FlagAction(StrictModel):
    action_type: Literal["FLAG_FOR_REVIEW"]
    finding_id: str
    record_uids: list[str]
    authorization_source: Literal["HUMAN"]
    authorization_ref: str


ApprovedAction = Annotated[
    NormalizeCategoryAction
    | StandardizeDateAction
    | ExcludeDuplicatesAction
    | QuarantineAction
    | ExcludeColumnAction
    | FlagAction,
    Field(discriminator="action_type"),
]


class DryRunReport(StrictModel):
    run_revision: int = Field(ge=1)
    source_artifact_hash: str
    approved_action_set_hash: str
    actions: list[ApprovedAction]
    finding_dispositions: dict[str, str]
    affected_record_count: int = Field(ge=0)
    affected_cell_count: int = Field(ge=0)
    eligible_record_count: int = Field(ge=0)
    quarantined_record_count: int = Field(ge=0)
    excluded_record_count: int = Field(ge=0)
    flagged_record_count: int = Field(ge=0)
    excluded_columns: list[str]
    blocking_unresolved: list[str]
    status: Literal["NOT_APPLIED"]
    decision_set_hash: str = ""


class ChangePreviewItem(StrictModel):
    record_uid: str
    display_key: str
    column: str
    before: str | None
    after: str | None
    finding_id: str
    action_type: AllowedAction = Field(strict=False)


class ChangePreview(StrictModel):
    changes: list[ChangePreviewItem]
    totals: dict[str, int]
    truncated: bool


# --------------------------------------------------------------------------------------
# Execution
# --------------------------------------------------------------------------------------


class ValidationResult(StrictModel):
    check_id: str
    passed: bool
    observed: Any
    expected: Any
    message_zh: str
    message_en: str


class ReleaseManifest(StrictModel):
    source_artifact_hash: str
    candidate_artifact_hash: str
    release_artifact_hash: str
    policy_pack_hash: str
    contract_hash: str
    engine_version: str
    score_version: str
    scope_hash: str
    total_source_records: int = Field(ge=0)
    eligible_record_count: int = Field(ge=0)
    quarantined_record_uids: list[str]
    excluded_record_uids: list[str]
    flagged_record_uids: list[str]
    excluded_columns: list[str]
    finding_outcome_counts: dict[str, int]
    validation_summary: dict[str, int]
    release_status: ReleaseStatus
    ai_call_count: int = Field(ge=0)
    ai_provider: ProviderName = Field(strict=False)
    decision_set_hash: str = ""
    change_ledger_hash: str = ""
    ai_input_hashes: dict[str, str] = Field(default_factory=dict)


class ExecutionResult(StrictModel):
    baseline_profile: ProfileSummary
    candidate_profile: ProfileSummary
    dry_run: DryRunReport
    validations: list[ValidationResult]
    release_manifest: ReleaseManifest


class DemoRelease(StrictModel):
    analysis: RunReport
    execution: ExecutionResult


# --------------------------------------------------------------------------------------
# Runs, events, history
# --------------------------------------------------------------------------------------


class RunSummary(StrictModel):
    run_id: str
    created_at: str
    source_name: str
    sample_id: str | None
    record_count: int | None
    column_count: int | None
    lifecycle: Lifecycle = Field(strict=False)
    release_status: ReleaseStatus | None = Field(default=None, strict=False)
    contract_source: ContractSource | None = Field(default=None, strict=False)
    run_revision: int = Field(ge=1)


class RunEvent(StrictModel):
    seq: int = Field(ge=1)
    ts: str
    stage: str
    status: EventStatus = Field(strict=False)
    message_zh: str
    message_en: str
    elapsed_ms: int | None
    detail: dict[str, Any]


class ErrorDetail(StrictModel):
    code: str
    message_zh: str
    message_en: str
    retryable: bool
    correlation_id: str


class ErrorResponse(StrictModel):
    error: ErrorDetail


class ContractView(StrictModel):
    yaml: str
    parsed: dict[str, Any]
    hash: str
    source: ContractSource = Field(strict=False)


# --------------------------------------------------------------------------------------
# AI: semantic mapping
# --------------------------------------------------------------------------------------


class SemanticRequest(StrictModel):
    finding_id: str
    column: str
    candidate_counts: dict[str, int]
    canonical_vocabulary: list[str]
    evidence_refs: list[str]
    ambiguity_tokens: list[str]


class AIProposal(StrictModel):
    finding_id: str
    proposed_action: Literal["NORMALIZE_CATEGORY"] | None
    column: str
    mapping: dict[str, str] | None
    evidence_refs: list[str]
    semantic_explanation: str
    ambiguity_flags: list[str]
    abstained: bool
    abstain_reason: str | None
    provider: str
    model: str
    prompt_version: str
    input_hash: str


# --------------------------------------------------------------------------------------
# AI: contract drafting
# --------------------------------------------------------------------------------------


class ContractDraftCanonical(StrictModel):
    target: str
    aliases: list[str]


class ContractDraftField(StrictModel):
    name: str
    required: bool
    unique: bool
    type: Literal["string", "integer", "number", "date", "datetime", "boolean"] | None
    format: str | None
    sensitive: bool
    allowed: list[str] = Field(max_length=20)
    canonical: list[ContractDraftCanonical]
    rationale_zh: str
    evidence_refs: list[str]


class ContractDraftAmbiguity(StrictModel):
    column: str
    tokens: list[str]


class ContractDraft(StrictModel):
    fields: list[ContractDraftField]
    business_key: list[str]
    ambiguity: list[ContractDraftAmbiguity]
    notes_zh: str


class RejectedRule(StrictModel):
    field: str
    rule: str
    reason_code: str
    detail_zh: str
    detail_en: str


class ContractDraftResult(StrictModel):
    status: DraftStatus
    draft_yaml: str | None
    accepted_rules: list[dict[str, Any]]
    rejected_rules: list[RejectedRule]
    ledger_call_id: str | None
    error: ErrorDetail | None = None


# --------------------------------------------------------------------------------------
# AI: release brief
# --------------------------------------------------------------------------------------


class ReleaseBriefClaim(StrictModel):
    text_zh: str
    text_en: str
    fact_ids: list[str]
    verified: bool
    reason: str | None


class ReleaseBrief(StrictModel):
    status: DraftStatus
    summary_zh: str
    summary_en: str
    claims: list[ReleaseBriefClaim]
    verified_count: int = Field(ge=0)
    total_count: int = Field(ge=0)
    ledger_call_id: str | None


# --------------------------------------------------------------------------------------
# AI: ledger
# --------------------------------------------------------------------------------------


class RedactionSummary(StrictModel):
    rows_sent: int = Field(ge=0)
    columns_withheld: list[str]
    values_sent: int = Field(ge=0)
    chars_sent: int = Field(ge=0)


class AICallRecord(StrictModel):
    call_id: str
    run_id: str
    task: AITask = Field(strict=False)
    provider: ProviderName = Field(strict=False)
    model_requested: str
    model_served: str | None
    prompt_version: str
    input_hash: str
    output_hash: str | None
    input_tokens: int | None
    output_tokens: int | None
    cache_read_tokens: int | None
    latency_ms: int = Field(ge=0)
    status: AIStatus = Field(strict=False)
    grounding: GroundingResult
    redaction: RedactionSummary
    request_id: str | None
    created_at: str
    # Additive fields (spec §5.5): the exact redacted request and the structured response.
    finding_id: str | None = None
    request_bytes: int = Field(default=0, ge=0)
    request_payload: dict[str, Any] = Field(default_factory=dict)
    response_payload: dict[str, Any] | None = None
    error: str | None = None
    cached_at: str | None = None


# --------------------------------------------------------------------------------------
# HTTP API request/response envelopes
# --------------------------------------------------------------------------------------


class RunDetail(StrictModel):
    run_id: str
    lifecycle: Lifecycle = Field(strict=False)
    source_name: str
    sample_id: str | None
    created_at: str
    run_revision: int = Field(ge=1)
    report: RunReport | None
    contract: ContractView | None
    decisions: dict[str, HumanDecision]
    dry_run: DryRunReport | None
    preview: ChangePreview | None
    execution: ExecutionResult | None
    brief: ReleaseBrief | None
    error: ErrorDetail | None


class SampleInfo(StrictModel):
    id: str
    title_zh: str
    title_en: str
    description_zh: str
    description_en: str
    rows: int = Field(ge=0)
    columns: int = Field(ge=0)
    has_contract: bool
    tags: list[str]


class RunCreated(StrictModel):
    run_id: str
    lifecycle: Lifecycle = Field(strict=False)
    run_revision: int = Field(ge=1)


class ApplyRequest(StrictModel):
    run_revision: int = Field(ge=1)
    approved_action_set_hash: str
    idempotency_key: str = Field(min_length=8, max_length=128)


class DecisionInput(StrictModel):
    finding_id: str
    outcome: DecisionOutcome = Field(strict=False)
    reason: str | None = None


class DecisionsRequest(StrictModel):
    decisions: list[DecisionInput]


class ContractPutRequest(StrictModel):
    yaml: str


class FromSampleRequest(StrictModel):
    sample_id: str
    with_contract: bool = True


class AIInfo(StrictModel):
    mode: str
    provider: ProviderName = Field(strict=False)
    model: str
    available: bool


class HealthInfo(StrictModel):
    status: str
    engine_version: str
    ai: AIInfo
    samples: int = Field(ge=0)


# --------------------------------------------------------------------------------------
# Offline verification (governance.verify_run, spec §4)
# --------------------------------------------------------------------------------------


class VerifyCheck(StrictModel):
    check_id: str
    passed: bool
    observed: Any
    expected: Any
    message_zh: str
    message_en: str


class VerifyReport(StrictModel):
    ok: bool
    checks: list[VerifyCheck]
