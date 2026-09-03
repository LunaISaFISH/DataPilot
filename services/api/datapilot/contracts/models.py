from __future__ import annotations

from enum import StrEnum
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class StrictModel(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")


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
    REJECT_PROPOSAL = "REJECT_PROPOSAL"


class MetricScore(StrictModel):
    name: str
    numerator: int
    denominator: int
    score: float | None


class ProfileSummary(StrictModel):
    dataset_hash: str
    record_count: int
    column_count: int
    scope_hash: str
    evaluation_scope_hash: str
    score_version: str
    metrics: list[MetricScore]
    overall_score: float | None


class EvidenceSignal(StrictModel):
    signal: str
    status: Literal["PASS", "FAIL", "NOT_APPLICABLE"]
    explanation: str
    evidence_ref: str


class Finding(StrictModel):
    finding_id: str
    finding_type: str
    title: str
    column: str | None
    affected_record_count: int = Field(ge=0)
    affected_cell_count: int = Field(ge=0)
    risk_level: RiskLevel
    blocking: bool
    authorization_mode: AuthorizationMode
    proposed_action: AllowedAction | None
    disposition: str
    evidence_signals: list[EvidenceSignal]
    record_uids: list[str]
    details: dict[str, Any]


class RunReport(StrictModel):
    schema_version: Literal["1.0"]
    engine_version: str
    fixture_version: str | None
    synthetic: bool
    profile: ProfileSummary
    findings: list[Finding]
    release_status: ReleaseStatus
    finding_outcome_counts: dict[str, int]
    warnings: list[str]


class RunCreated(StrictModel):
    run_id: str
    report: RunReport


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
    authorization_source: Literal["POLICY"]
    authorization_ref: str


class ExcludeDuplicatesAction(StrictModel):
    action_type: Literal["EXCLUDE_EXACT_DUPLICATE_FROM_RELEASE"]
    finding_id: str
    record_uids: list[str]
    authorization_source: Literal["POLICY"]
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


ApprovedAction = Annotated[
    NormalizeCategoryAction
    | StandardizeDateAction
    | ExcludeDuplicatesAction
    | QuarantineAction
    | ExcludeColumnAction,
    Field(discriminator="action_type"),
]


class DryRunReport(StrictModel):
    run_revision: int
    source_artifact_hash: str
    approved_action_set_hash: str
    actions: list[ApprovedAction]
    finding_dispositions: dict[str, str]
    affected_record_count: int
    affected_cell_count: int
    eligible_record_count: int
    quarantined_record_count: int
    excluded_record_count: int
    excluded_columns: list[str]
    status: Literal["NOT_APPLIED"]


class ValidationResult(StrictModel):
    check_id: str
    passed: bool
    observed: Any
    expected: Any
    message: str


class ReleaseManifest(StrictModel):
    source_artifact_hash: str
    candidate_artifact_hash: str
    release_artifact_hash: str
    policy_pack_hash: str
    engine_version: str
    score_version: str
    scope_hash: str
    total_source_records: int
    eligible_record_count: int
    quarantined_record_uids: list[str]
    excluded_record_uids: list[str]
    excluded_columns: list[str]
    finding_outcome_counts: dict[str, int]
    validation_summary: dict[str, int]
    release_status: ReleaseStatus


class ExecutionResult(StrictModel):
    baseline_profile: ProfileSummary
    candidate_profile: ProfileSummary
    dry_run: DryRunReport
    validations: list[ValidationResult]
    release_manifest: ReleaseManifest


class DemoRelease(StrictModel):
    analysis: RunReport
    execution: ExecutionResult


class ApplyRequest(StrictModel):
    run_revision: int = Field(ge=1)
    approved_action_set_hash: str
    idempotency_key: str = Field(min_length=8, max_length=128)


class ErrorDetail(StrictModel):
    code: str
    message: str
    retryable: bool
    run_id: str | None = None
    correlation_id: str


class ErrorResponse(StrictModel):
    error: ErrorDetail


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


class GroundingResult(StrictModel):
    valid: bool
    reason_codes: list[str]
    affected_record_count: int
