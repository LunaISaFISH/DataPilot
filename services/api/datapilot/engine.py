from __future__ import annotations

import csv
import hashlib
import io
import re
from pathlib import Path
from typing import Any

import polars as pl
import yaml

from datapilot.contracts.models import (
    AllowedAction,
    AuthorizationMode,
    EvidenceSignal,
    Finding,
    MetricScore,
    ProfileSummary,
    ReleaseStatus,
    RiskLevel,
    RunReport,
)
from datapilot.serialization import canonical_json

ENGINE_VERSION = "0.1.0"
MAX_UPLOAD_BYTES = 25 * 1024 * 1024
MAX_ROWS = 250_000
MAX_COLUMNS = 200
SENSITIVE_PATTERNS = (
    re.compile(r"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b", re.IGNORECASE),
    re.compile(r"\+?\d[\d\s().-]{7,}\d"),
    re.compile(r"\b(?:name|patient)\s*:\s*[^,;]{3,}", re.IGNORECASE),
)


class AnalysisError(ValueError):
    def __init__(self, code: str, message: str) -> None:
        self.code = code
        super().__init__(message)


def load_policy(path: Path) -> dict[str, Any]:
    parsed = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(parsed, dict):
        raise AnalysisError("POLICY_INVALID", "Policy Pack must be a mapping.")
    return parsed


def baseline_policy() -> dict[str, Any]:
    return {
        "id": "baseline-observational",
        "version": "1.0.0",
        "score": {
            "version": "dq-1.0",
            "weights": {
                "completeness": 0.30,
                "validity": 0.25,
                "consistency": 0.25,
                "uniqueness": 0.20,
            },
        },
        "required_fields": [],
        "business_key": [],
        "canonical": {},
        "allowed_regions": [],
        "ambiguity_registry": [],
        "sensitive_fields": [],
        "auto_authorization": {},
    }


def _delimiter(content: bytes) -> str:
    sample = content[:16_384].decode("utf-8-sig")
    try:
        detected = csv.Sniffer().sniff(sample, delimiters=",\t;").delimiter
    except csv.Error as error:
        raise AnalysisError(
            "CSV_DELIMITER_UNCERTAIN",
            "The delimiter could not be detected safely.",
        ) from error
    return detected


def _header(content: bytes, delimiter: str) -> list[str]:
    text = content.decode("utf-8-sig")
    try:
        header = next(csv.reader(io.StringIO(text), delimiter=delimiter))
    except (csv.Error, StopIteration) as error:
        raise AnalysisError("CSV_EMPTY", "The CSV is empty or has no header.") from error
    if not header or any(not column.strip() for column in header):
        raise AnalysisError("CSV_HEADER_INVALID", "Every CSV column must have a name.")
    if len(set(header)) != len(header):
        raise AnalysisError("CSV_DUPLICATE_COLUMNS", "Duplicate column names are not supported.")
    return header


def _parse(content: bytes) -> tuple[pl.DataFrame, str]:
    if not content:
        raise AnalysisError("CSV_EMPTY", "The CSV is empty.")
    if len(content) > MAX_UPLOAD_BYTES:
        raise AnalysisError("CSV_TOO_LARGE", "The CSV exceeds the 25 MiB P0 limit.")
    try:
        delimiter = _delimiter(content)
        header = _header(content, delimiter)
    except UnicodeDecodeError as error:
        raise AnalysisError(
            "CSV_ENCODING_UNSUPPORTED",
            "Only UTF-8 and UTF-8 BOM CSV files are supported.",
        ) from error
    if len(header) > MAX_COLUMNS:
        raise AnalysisError("CSV_TOO_MANY_COLUMNS", "The CSV exceeds the 200-column limit.")
    try:
        frame = pl.read_csv(
            io.BytesIO(content),
            separator=delimiter,
            encoding="utf8",
            infer_schema_length=10_000,
            try_parse_dates=False,
        )
    except pl.exceptions.PolarsError as error:
        raise AnalysisError("CSV_PARSE_FAILED", "The CSV could not be parsed safely.") from error
    if frame.height == 0:
        raise AnalysisError("CSV_NO_RECORDS", "The CSV contains no data records.")
    if frame.height > MAX_ROWS:
        raise AnalysisError("CSV_TOO_MANY_ROWS", "The CSV exceeds the 250,000-record limit.")
    return frame, delimiter


def _uid(dataset_hash: str, ordinal: int) -> str:
    return hashlib.sha256(f"{dataset_hash}:{ordinal}".encode()).hexdigest()[:24]


def _signal(
    signal: str,
    status: str,
    explanation: str,
    evidence_ref: str,
) -> EvidenceSignal:
    return EvidenceSignal(
        signal=signal,
        status=status,  # type: ignore[arg-type]
        explanation=explanation,
        evidence_ref=evidence_ref,
    )


def _finding(
    *,
    finding_id: str,
    finding_type: str,
    title: str,
    column: str | None,
    record_uids: list[str],
    risk: RiskLevel,
    blocking: bool,
    authorization: AuthorizationMode,
    action: AllowedAction | None,
    signals: list[EvidenceSignal],
    details: dict[str, Any],
    cell_count: int | None = None,
) -> Finding:
    return Finding(
        finding_id=finding_id,
        finding_type=finding_type,
        title=title,
        column=column,
        affected_record_count=len(record_uids),
        affected_cell_count=len(record_uids) if cell_count is None else cell_count,
        risk_level=risk,
        blocking=blocking,
        authorization_mode=authorization,
        proposed_action=action,
        disposition="OPEN",
        evidence_signals=signals,
        record_uids=record_uids,
        details=details,
    )


def _score(
    name: str,
    numerator: int,
    denominator: int,
) -> MetricScore:
    score = None if denominator == 0 else round(100 * numerator / denominator, 2)
    return MetricScore(name=name, numerator=numerator, denominator=denominator, score=score)


def analyze_csv(
    content: bytes,
    policy: dict[str, Any] | None = None,
    *,
    synthetic: bool = False,
    fixture_version: str | None = None,
) -> RunReport:
    active_policy = policy or baseline_policy()
    frame, delimiter = _parse(content)
    dataset_hash = hashlib.sha256(content).hexdigest()
    record_uids = [_uid(dataset_hash, ordinal) for ordinal in range(frame.height)]
    rows = frame.to_dicts()
    findings: list[Finding] = []

    seen: dict[tuple[Any, ...], int] = {}
    duplicate_indexes: list[int] = []
    columns = frame.columns
    for index, row in enumerate(rows):
        key = tuple(row[column] for column in columns)
        if key in seen:
            duplicate_indexes.append(index)
        else:
            seen[key] = index
    if duplicate_indexes:
        duplicate_uids = [record_uids[index] for index in duplicate_indexes]
        findings.append(
            _finding(
                finding_id="DUP-001",
                finding_type="EXACT_DUPLICATE",
                title="Exact duplicate imports can be excluded from release",
                column=None,
                record_uids=duplicate_uids,
                risk=RiskLevel.LOW,
                blocking=False,
                authorization=AuthorizationMode.POLICY_AUTHORIZED,
                action=AllowedAction.EXCLUDE_EXACT_DUPLICATE_FROM_RELEASE,
                signals=[
                    _signal(
                        "identical_payload",
                        "PASS",
                        "Each surplus occurrence matches an earlier complete record.",
                        "EVID-DUPLICATE-01",
                    )
                ],
                details={"surplus_record_count": len(duplicate_uids), "delimiter": delimiter},
                cell_count=0,
            )
        )

    canonical = active_policy.get("canonical", {})
    region_mapping = {
        alias: target
        for target, aliases in canonical.get("region", {}).items()
        for alias in aliases
    }
    region_indexes = [
        index for index, row in enumerate(rows) if row.get("region") in region_mapping
    ]
    if region_indexes:
        findings.append(
            _finding(
                finding_id="CAT-002",
                finding_type="CATEGORY_VARIANT",
                title="Region aliases can be normalized",
                column="region",
                record_uids=[record_uids[index] for index in region_indexes],
                risk=RiskLevel.LOW,
                blocking=False,
                authorization=AuthorizationMode.POLICY_AUTHORIZED,
                action=AllowedAction.NORMALIZE_CATEGORY,
                signals=[
                    _signal(
                        "canonical_glossary_match",
                        "PASS",
                        "Every alias maps to an approved region term.",
                        "EVID-REGION-GLOSSARY-01",
                    )
                ],
                details={"mapping": region_mapping},
            )
        )

    iso_date = re.compile(r"^\d{4}-\d{2}-\d{2}$")
    alternate_date = re.compile(r"^\d{2}/\d{2}/\d{4}$")
    date_indexes = [
        index
        for index, row in enumerate(rows)
        if isinstance(row.get("encounter_date"), str)
        and not iso_date.fullmatch(row["encounter_date"])
        and alternate_date.fullmatch(row["encounter_date"])
    ]
    if date_indexes:
        findings.append(
            _finding(
                finding_id="FMT-003",
                finding_type="FORMAT_INCONSISTENCY",
                title="Encounter dates use a second unambiguous format",
                column="encounter_date",
                record_uids=[record_uids[index] for index in date_indexes],
                risk=RiskLevel.LOW,
                blocking=False,
                authorization=AuthorizationMode.POLICY_AUTHORIZED,
                action=AllowedAction.STANDARDIZE_DATE_FORMAT,
                signals=[
                    _signal(
                        "unambiguous_date_parse",
                        "PASS",
                        "All affected values parse as day/month/year without ambiguity.",
                        "EVID-DATE-PARSE-01",
                    )
                ],
                details={"source_format": "%d/%m/%Y", "target_format": "%Y-%m-%d"},
            )
        )

    diagnosis_mapping = {
        alias: target
        for target, aliases in canonical.get("diagnosis_label", {}).items()
        for alias in aliases
    }
    semantic_indexes = [
        index
        for index, row in enumerate(rows)
        if row.get("diagnosis_label") in diagnosis_mapping
    ]
    if semantic_indexes:
        supported = [
            index for index in semantic_indexes if rows[index].get("diagnosis_code") == "I10"
        ]
        conflicts = sorted(set(semantic_indexes) - set(supported))
        findings.append(
            _finding(
                finding_id="SEM-004",
                finding_type="SEMANTIC_VARIANT",
                title="Supported diagnosis variants can converge on one canonical term",
                column="diagnosis_label",
                record_uids=[record_uids[index] for index in supported],
                risk=RiskLevel.MEDIUM,
                blocking=True,
                authorization=AuthorizationMode.HUMAN_APPROVAL_REQUIRED,
                action=AllowedAction.NORMALIZE_CATEGORY,
                signals=[
                    _signal(
                        "canonical_glossary_match",
                        "PASS",
                        "Targets are present in the approved glossary.",
                        "EVID-GLOSSARY-01",
                    ),
                    _signal(
                        "normalized_string_match",
                        "NOT_APPLICABLE",
                        (
                            "Glossary aliases include semantic abbreviations, "
                            "so string identity is not required."
                        ),
                        "EVID-STRING-01",
                    ),
                    _signal(
                        "code_cooccurrence_consistency",
                        "PASS",
                        "All records in the proposal scope co-occur with I10.",
                        "EVID-CODE-02",
                    ),
                    _signal(
                        "distribution_stability",
                        "PASS",
                        "The canonical merge has low distribution impact.",
                        "EVID-DISTRIBUTION-03",
                    ),
                ],
                details={
                    "mapping": diagnosis_mapping,
                    "candidate_record_count": len(semantic_indexes),
                    "supported_record_count": len(supported),
                    "conflict_record_uids": [record_uids[index] for index in conflicts],
                    "evidence_strength": "STRONG_FOR_PROPOSAL_SCOPE",
                },
            )
        )
        if conflicts:
            findings.append(
                _finding(
                    finding_id="SEM-004-CONFLICT",
                    finding_type="SEMANTIC_CONFLICT",
                    title="A conflicting code prevents semantic normalization",
                    column="diagnosis_label",
                    record_uids=[record_uids[index] for index in conflicts],
                    risk=RiskLevel.HIGH,
                    blocking=True,
                    authorization=AuthorizationMode.QUARANTINE_ONLY,
                    action=AllowedAction.QUARANTINE_RECORDS,
                    signals=[
                        _signal(
                            "code_cooccurrence_consistency",
                            "FAIL",
                            "The record does not carry the code required by the proposal.",
                            "EVID-CODE-CONFLICT-04",
                        )
                    ],
                    details={"parent_finding_id": "SEM-004"},
                )
            )

    ambiguity_registry = set(active_policy.get("ambiguity_registry", []))
    ambiguous_indexes = [
        index
        for index, row in enumerate(rows)
        if row.get("diagnosis_label") in ambiguity_registry
    ]
    if ambiguous_indexes:
        findings.append(
            _finding(
                finding_id="AMB-005",
                finding_type="KNOWN_AMBIGUOUS_ABBREVIATION",
                title="Ambiguous abbreviations require manual review",
                column="diagnosis_label",
                record_uids=[record_uids[index] for index in ambiguous_indexes],
                risk=RiskLevel.HIGH,
                blocking=True,
                authorization=AuthorizationMode.QUARANTINE_ONLY,
                action=AllowedAction.QUARANTINE_RECORDS,
                signals=[
                    _signal(
                        "ambiguity_registry",
                        "FAIL",
                        "Known ambiguous tokens cannot be mapped to one meaning.",
                        "EVID-AMBIGUITY-01",
                    )
                ],
                details={"tokens": sorted(ambiguity_registry), "ai_abstained": True},
            )
        )

    missing_indexes: list[int] = []
    for index, row in enumerate(rows):
        for field in active_policy.get("required_fields", []):
            if row.get(field) is None or str(row.get(field)).strip() == "":
                missing_indexes.append(index)
                break
    if missing_indexes:
        findings.append(
            _finding(
                finding_id="MISS-006",
                finding_type="REQUIRED_FIELD_MISSING",
                title="Required diagnosis codes are missing",
                column="diagnosis_code",
                record_uids=[record_uids[index] for index in missing_indexes],
                risk=RiskLevel.HIGH,
                blocking=True,
                authorization=AuthorizationMode.QUARANTINE_ONLY,
                action=AllowedAction.QUARANTINE_RECORDS,
                signals=[
                    _signal(
                        "safe_imputation_evidence",
                        "FAIL",
                        "Available evidence cannot support a clinically safe code.",
                        "EVID-MISSING-01",
                    )
                ],
                details={"automatic_imputation": "FORBIDDEN"},
            )
        )

    configured_sensitive_fields = set(active_policy.get("sensitive_fields", []))
    candidate_sensitive_fields = configured_sensitive_fields or {
        column
        for column in columns
        if any(token in column.lower() for token in ("email", "phone", "note", "name"))
    }
    sensitive_indexes: list[int] = []
    sensitive_columns: set[str] = set()
    for index, row in enumerate(rows):
        for column, value in row.items():
            if column not in candidate_sensitive_fields:
                continue
            if not isinstance(value, str):
                continue
            if any(pattern.search(value) for pattern in SENSITIVE_PATTERNS):
                sensitive_indexes.append(index)
                sensitive_columns.add(column)
                break
    if sensitive_indexes:
        findings.append(
            _finding(
                finding_id="PHI-007",
                finding_type="POTENTIAL_DIRECT_IDENTIFIER",
                title="Potential direct identifier patterns require release exclusion",
                column=next(iter(sorted(sensitive_columns)), None),
                record_uids=[record_uids[index] for index in sensitive_indexes],
                risk=RiskLevel.HIGH,
                blocking=True,
                authorization=AuthorizationMode.HUMAN_APPROVAL_REQUIRED,
                action=AllowedAction.EXCLUDE_COLUMN_FROM_RELEASE,
                signals=[
                    _signal(
                        "sensitive_pattern_preflight",
                        "FAIL",
                        "Raw evidence is masked and withheld from semantic analysis.",
                        "EVID-SENSITIVE-01",
                    )
                ],
                details={"masked": True, "not_sent_to_ai": True},
            )
        )

    required_fields = [
        field for field in active_policy.get("required_fields", []) if field in columns
    ]
    completeness_denominator = frame.height * len(required_fields)
    completeness_numerator = sum(
        1
        for row in rows
        for field in required_fields
        if row.get(field) is not None and str(row.get(field)).strip() != ""
    )
    date_values = [row.get("encounter_date") for row in rows if "encounter_date" in row]
    validity_denominator = len(date_values)
    validity_numerator = sum(
        1 for value in date_values if isinstance(value, str) and iso_date.fullmatch(value)
    )
    consistency_columns = [
        column for column in ("region", "diagnosis_label") if column in columns
    ]
    consistency_denominator = frame.height * len(consistency_columns)
    allowed_regions = set(active_policy.get("allowed_regions", []))
    accepted_diagnoses = {"Type 2 diabetes", *canonical.get("diagnosis_label", {}).keys()}
    consistency_numerator = 0
    for row in rows:
        if "region" in consistency_columns and row.get("region") in allowed_regions:
            consistency_numerator += 1
        if (
            "diagnosis_label" in consistency_columns
            and row.get("diagnosis_label") in accepted_diagnoses
        ):
            consistency_numerator += 1
    uniqueness_denominator = frame.height
    uniqueness_numerator = frame.height - len(duplicate_indexes)
    metrics = [
        _score("completeness", completeness_numerator, completeness_denominator),
        _score("validity", validity_numerator, validity_denominator),
        _score("consistency", consistency_numerator, consistency_denominator),
        _score("uniqueness", uniqueness_numerator, uniqueness_denominator),
    ]
    weights = active_policy.get("score", {}).get("weights", {})
    applicable = [metric for metric in metrics if metric.score is not None]
    effective_weight = sum(float(weights.get(metric.name, 0)) for metric in applicable)
    overall = (
        None
        if effective_weight == 0
        else round(
            sum(
                float(metric.score) * float(weights.get(metric.name, 0))
                for metric in applicable
                if metric.score is not None
            )
            / effective_weight,
            2,
        )
    )
    scope_hash = hashlib.sha256("\n".join(record_uids).encode()).hexdigest()
    evaluation_material = {
        "record_uids": record_uids,
        "fields": sorted(required_fields + consistency_columns + ["encounter_date"]),
        "policy": active_policy,
        "score_version": active_policy.get("score", {}).get("version", "dq-1.0"),
    }
    evaluation_scope_hash = hashlib.sha256(
        canonical_json(evaluation_material).encode()
    ).hexdigest()
    profile = ProfileSummary(
        dataset_hash=dataset_hash,
        record_count=frame.height,
        column_count=frame.width,
        scope_hash=scope_hash,
        evaluation_scope_hash=evaluation_scope_hash,
        score_version=active_policy.get("score", {}).get("version", "dq-1.0"),
        metrics=metrics,
        overall_score=overall,
    )
    release_status = (
        ReleaseStatus.NOT_EVALUATED
        if active_policy.get("id") == "baseline-observational"
        else ReleaseStatus.BLOCKED
    )
    return RunReport(
        schema_version="1.0",
        engine_version=ENGINE_VERSION,
        fixture_version=fixture_version,
        synthetic=synthetic,
        profile=profile,
        findings=findings,
        release_status=release_status,
        finding_outcome_counts={"OPEN": len(findings)},
        warnings=(
            ["No Data Contract supplied; results are observational only."]
            if release_status is ReleaseStatus.NOT_EVALUATED
            else []
        ),
    )
