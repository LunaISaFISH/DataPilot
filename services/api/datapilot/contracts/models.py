from __future__ import annotations

from enum import StrEnum
from typing import Any, Literal

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


class ErrorDetail(StrictModel):
    code: str
    message: str
    retryable: bool
    run_id: str | None = None
    correlation_id: str


class ErrorResponse(StrictModel):
    error: ErrorDetail
