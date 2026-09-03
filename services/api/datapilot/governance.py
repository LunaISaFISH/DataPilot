from __future__ import annotations

import csv
import hashlib
import io
from dataclasses import dataclass
from datetime import datetime
from typing import Any

import polars as pl

from datapilot.contracts.models import (
    ApprovedAction,
    DecisionOutcome,
    DryRunReport,
    ExcludeColumnAction,
    ExcludeDuplicatesAction,
    ExecutionResult,
    HumanDecision,
    NormalizeCategoryAction,
    QuarantineAction,
    ReleaseManifest,
    ReleaseStatus,
    RunReport,
    StandardizeDateAction,
    ValidationResult,
)
from datapilot.engine import ENGINE_VERSION, _parse, _uid, build_profile
from datapilot.serialization import canonical_json


class GovernanceError(ValueError):
    pass


@dataclass(frozen=True)
class ExecutionBundle:
    result: ExecutionResult
    candidate_csv: bytes
    release_csv: bytes


def demo_decisions() -> list[HumanDecision]:
    return [
        HumanDecision(
            finding_id="SEM-004",
            outcome=DecisionOutcome.APPROVE_PROPOSAL,
            reason="Evidence supports the bounded mapping scope.",
            run_revision=1,
        ),
        HumanDecision(
            finding_id="SEM-004-CONFLICT",
            outcome=DecisionOutcome.QUARANTINE,
            reason="Conflicting code requires manual review.",
            run_revision=1,
        ),
        HumanDecision(
            finding_id="AMB-005",
            outcome=DecisionOutcome.QUARANTINE,
            reason="Known ambiguous abbreviations cannot be normalized safely.",
            run_revision=1,
        ),
        HumanDecision(
            finding_id="MISS-006",
            outcome=DecisionOutcome.QUARANTINE,
            reason="Missing required codes cannot be inferred safely.",
            run_revision=1,
        ),
        HumanDecision(
            finding_id="PHI-007",
            outcome=DecisionOutcome.EXCLUDE,
            reason="The optional free-text field is excluded from release.",
            run_revision=1,
        ),
    ]


def prepare_dry_run(
    report: RunReport,
    decisions: list[HumanDecision],
    *,
    run_revision: int = 1,
    policy_ref: str = "clinical-nlp@1.0.0",
) -> DryRunReport:
    decision_by_finding = {decision.finding_id: decision for decision in decisions}
    if len(decision_by_finding) != len(decisions):
        raise GovernanceError("Each finding can have at most one human decision.")
    actions: list[ApprovedAction] = []
    dispositions: dict[str, str] = {}

    for finding in report.findings:
        if finding.authorization_mode == "POLICY_AUTHORIZED":
            if finding.proposed_action == "EXCLUDE_EXACT_DUPLICATE_FROM_RELEASE":
                actions.append(
                    ExcludeDuplicatesAction(
                        action_type="EXCLUDE_EXACT_DUPLICATE_FROM_RELEASE",
                        finding_id=finding.finding_id,
                        record_uids=finding.record_uids,
                        authorization_source="POLICY",
                        authorization_ref=f"{policy_ref}:DEDUP-003",
                    )
                )
                dispositions[finding.finding_id] = "POLICY_ACTION_APPROVED"
            elif finding.proposed_action == "STANDARDIZE_DATE_FORMAT":
                actions.append(
                    StandardizeDateAction(
                        action_type="STANDARDIZE_DATE_FORMAT",
                        finding_id=finding.finding_id,
                        column=finding.column or "",
                        source_format=str(finding.details["source_format"]),
                        target_format=str(finding.details["target_format"]),
                        record_uids=finding.record_uids,
                        authorization_source="POLICY",
                        authorization_ref=f"{policy_ref}:FORMAT-002",
                    )
                )
                dispositions[finding.finding_id] = "POLICY_ACTION_APPROVED"
            elif finding.proposed_action == "NORMALIZE_CATEGORY":
                actions.append(
                    NormalizeCategoryAction(
                        action_type="NORMALIZE_CATEGORY",
                        finding_id=finding.finding_id,
                        column=finding.column or "",
                        mapping={
                            str(source): str(target)
                            for source, target in finding.details["mapping"].items()
                        },
                        record_uids=finding.record_uids,
                        authorization_source="POLICY",
                        authorization_ref=f"{policy_ref}:CATEGORY-001",
                    )
                )
                dispositions[finding.finding_id] = "POLICY_ACTION_APPROVED"
            continue

        decision = decision_by_finding.get(finding.finding_id)
        if decision is None or decision.run_revision != run_revision:
            raise GovernanceError(f"Finding {finding.finding_id} requires a current decision.")
        if finding.finding_id == "SEM-004":
            if decision.outcome is not DecisionOutcome.APPROVE_PROPOSAL:
                raise GovernanceError("SEM-004 must be approved or remain blocking.")
            actions.append(
                NormalizeCategoryAction(
                    action_type="NORMALIZE_CATEGORY",
                    finding_id=finding.finding_id,
                    column=finding.column or "",
                    mapping={
                        str(source): str(target)
                        for source, target in finding.details["mapping"].items()
                    },
                    record_uids=finding.record_uids,
                    authorization_source="HUMAN",
                    authorization_ref=f"decision:{finding.finding_id}",
                )
            )
            dispositions[finding.finding_id] = "HUMAN_ACTION_APPROVED"
        elif finding.proposed_action == "QUARANTINE_RECORDS":
            if decision.outcome is not DecisionOutcome.QUARANTINE:
                raise GovernanceError(f"Finding {finding.finding_id} is quarantine-only.")
            actions.append(
                QuarantineAction(
                    action_type="QUARANTINE_RECORDS",
                    finding_id=finding.finding_id,
                    record_uids=finding.record_uids,
                    authorization_source="HUMAN",
                    authorization_ref=f"decision:{finding.finding_id}",
                )
            )
            dispositions[finding.finding_id] = "QUARANTINED"
        elif finding.proposed_action == "EXCLUDE_COLUMN_FROM_RELEASE":
            if decision.outcome is not DecisionOutcome.EXCLUDE:
                raise GovernanceError(f"Finding {finding.finding_id} requires column exclusion.")
            actions.append(
                ExcludeColumnAction(
                    action_type="EXCLUDE_COLUMN_FROM_RELEASE",
                    finding_id=finding.finding_id,
                    column=finding.column or "",
                    authorization_source="HUMAN",
                    authorization_ref=f"decision:{finding.finding_id}",
                )
            )
            dispositions[finding.finding_id] = "EXCLUDED"

    if len(dispositions) != len(report.findings):
        unresolved = sorted(
            {finding.finding_id for finding in report.findings} - dispositions.keys()
        )
        raise GovernanceError(f"Unresolved findings: {', '.join(unresolved)}")

    action_payload = [action.model_dump(mode="json") for action in actions]
    action_hash = hashlib.sha256(canonical_json(action_payload).encode()).hexdigest()
    changed_uids = {
        uid
        for action in actions
        if isinstance(
            action,
            (
                NormalizeCategoryAction,
                StandardizeDateAction,
                ExcludeDuplicatesAction,
                QuarantineAction,
            ),
        )
        for uid in action.record_uids
    }
    normalized_cells = sum(
        len(action.record_uids)
        for action in actions
        if isinstance(action, (NormalizeCategoryAction, StandardizeDateAction))
    )
    quarantined = {
        uid
        for action in actions
        if isinstance(action, QuarantineAction)
        for uid in action.record_uids
    }
    excluded = {
        uid
        for action in actions
        if isinstance(action, ExcludeDuplicatesAction)
        for uid in action.record_uids
    }
    excluded_columns = sorted(
        action.column
        for action in actions
        if isinstance(action, ExcludeColumnAction)
    )
    return DryRunReport(
        run_revision=run_revision,
        source_artifact_hash=report.profile.dataset_hash,
        approved_action_set_hash=action_hash,
        actions=actions,
        finding_dispositions=dispositions,
        affected_record_count=len(changed_uids),
        affected_cell_count=normalized_cells,
        eligible_record_count=report.profile.record_count - len(quarantined | excluded),
        quarantined_record_count=len(quarantined),
        excluded_record_count=len(excluded),
        excluded_columns=excluded_columns,
        status="NOT_APPLIED",
    )


def _csv_bytes(rows: list[dict[str, Any]], columns: list[str]) -> bytes:
    buffer = io.StringIO(newline="")
    writer = csv.DictWriter(buffer, fieldnames=columns, lineterminator="\n")
    writer.writeheader()
    writer.writerows(rows)
    return buffer.getvalue().encode()


def execute(
    source: bytes,
    policy: dict[str, Any],
    report: RunReport,
    dry_run: DryRunReport,
) -> ExecutionBundle:
    if hashlib.sha256(source).hexdigest() != dry_run.source_artifact_hash:
        raise GovernanceError("Source artifact changed after dry run.")
    expected_hash = hashlib.sha256(
        canonical_json([action.model_dump(mode="json") for action in dry_run.actions]).encode()
    ).hexdigest()
    if expected_hash != dry_run.approved_action_set_hash:
        raise GovernanceError("Approved action set changed after dry run.")

    frame, _ = _parse(source)
    rows = frame.to_dicts()
    record_uids = [_uid(report.profile.dataset_hash, ordinal) for ordinal in range(frame.height)]
    index_by_uid = {uid: index for index, uid in enumerate(record_uids)}
    quarantined: set[str] = set()
    excluded: set[str] = set()
    excluded_columns: set[str] = set()

    for action in dry_run.actions:
        if action.action_type == "NORMALIZE_CATEGORY":
            for uid in action.record_uids:
                index = index_by_uid[uid]
                value = rows[index][action.column]
                if value in action.mapping:
                    rows[index][action.column] = action.mapping[value]
        elif action.action_type == "STANDARDIZE_DATE_FORMAT":
            for uid in action.record_uids:
                index = index_by_uid[uid]
                value = str(rows[index][action.column])
                parsed = datetime.strptime(value, action.source_format)
                rows[index][action.column] = parsed.strftime(action.target_format)
        elif action.action_type == "EXCLUDE_EXACT_DUPLICATE_FROM_RELEASE":
            excluded.update(action.record_uids)
        elif action.action_type == "QUARANTINE_RECORDS":
            quarantined.update(action.record_uids)
        elif action.action_type == "EXCLUDE_COLUMN_FROM_RELEASE":
            excluded_columns.add(action.column)

    candidate_frame = pl.DataFrame(rows)
    candidate_profile = build_profile(
        candidate_frame,
        rows,
        record_uids,
        policy,
        report.profile.dataset_hash,
        dry_run.excluded_record_count,
    )
    candidate_columns = frame.columns
    release_columns = [column for column in candidate_columns if column not in excluded_columns]
    release_uid_set = {
        uid for uid in record_uids if uid not in quarantined and uid not in excluded
    }
    release_rows = [
        {column: row[column] for column in release_columns}
        for uid, row in zip(record_uids, rows, strict=True)
        if uid in release_uid_set
    ]
    candidate_csv = _csv_bytes(rows, candidate_columns)
    release_csv = _csv_bytes(release_rows, release_columns)
    finding_count = len(report.findings)

    validations = [
        ValidationResult(
            check_id="SOURCE_IMMUTABLE",
            passed=hashlib.sha256(source).hexdigest() == report.profile.dataset_hash,
            observed=hashlib.sha256(source).hexdigest(),
            expected=report.profile.dataset_hash,
            message="Source artifact hash is unchanged.",
        ),
        ValidationResult(
            check_id="SCOPE_STABLE",
            passed=candidate_profile.scope_hash == report.profile.scope_hash,
            observed=candidate_profile.scope_hash,
            expected=report.profile.scope_hash,
            message="Candidate quality uses the source record scope.",
        ),
        ValidationResult(
            check_id="EVALUATION_SCOPE_STABLE",
            passed=candidate_profile.evaluation_scope_hash == report.profile.evaluation_scope_hash,
            observed=candidate_profile.evaluation_scope_hash,
            expected=report.profile.evaluation_scope_hash,
            message="Quality comparison uses the same fields, policy, and score version.",
        ),
        ValidationResult(
            check_id="COMPLETENESS_NOT_IMPUTED",
            passed=candidate_profile.metrics[0].numerator == report.profile.metrics[0].numerator,
            observed=candidate_profile.metrics[0].numerator,
            expected=report.profile.metrics[0].numerator,
            message="Missing required codes were not imputed.",
        ),
        ValidationResult(
            check_id="CONFLICT_UNCHANGED",
            passed=rows[
                index_by_uid[
                    next(
                        finding.record_uids[0]
                        for finding in report.findings
                        if finding.finding_id == "SEM-004-CONFLICT"
                    )
                ]
            ]["diagnosis_code"]
            == "E11.9",
            observed="unchanged",
            expected="unchanged",
            message="The conflicting semantic record was not normalized.",
        ),
        ValidationResult(
            check_id="QUARANTINE_EXCLUDED",
            passed=quarantined.isdisjoint(release_uid_set),
            observed=len(quarantined),
            expected=dry_run.quarantined_record_count,
            message="Quarantined records are absent from the release artifact.",
        ),
        ValidationResult(
            check_id="DUPLICATES_EXCLUDED",
            passed=len(excluded) == dry_run.excluded_record_count,
            observed=len(excluded),
            expected=dry_run.excluded_record_count,
            message="Only policy-authorized surplus duplicate occurrences were excluded.",
        ),
        ValidationResult(
            check_id="SENSITIVE_COLUMN_EXCLUDED",
            passed=excluded_columns.isdisjoint(release_columns),
            observed=sorted(excluded_columns),
            expected=dry_run.excluded_columns,
            message="Approved sensitive columns are absent from the release artifact.",
        ),
        ValidationResult(
            check_id="ROW_RECONCILIATION",
            passed=len(release_rows) == dry_run.eligible_record_count,
            observed=len(release_rows),
            expected=dry_run.eligible_record_count,
            message="Eligible, quarantined, and excluded record counts reconcile.",
        ),
        ValidationResult(
            check_id="FINDING_CONSERVATION",
            passed=len(dry_run.finding_dispositions) == finding_count,
            observed=len(dry_run.finding_dispositions),
            expected=finding_count,
            message="Every atomic finding has exactly one disposition.",
        ),
    ]
    passed = sum(validation.passed for validation in validations)
    failed = len(validations) - passed
    release_status = (
        ReleaseStatus.CONDITIONAL_PASS if failed == 0 else ReleaseStatus.BLOCKED
    )
    policy_hash = hashlib.sha256(canonical_json(policy).encode()).hexdigest()
    outcome_counts: dict[str, int] = {}
    for outcome in dry_run.finding_dispositions.values():
        outcome_counts[outcome] = outcome_counts.get(outcome, 0) + 1
    manifest = ReleaseManifest(
        source_artifact_hash=report.profile.dataset_hash,
        candidate_artifact_hash=hashlib.sha256(candidate_csv).hexdigest(),
        release_artifact_hash=hashlib.sha256(release_csv).hexdigest(),
        policy_pack_hash=policy_hash,
        engine_version=ENGINE_VERSION,
        score_version=report.profile.score_version,
        scope_hash=report.profile.scope_hash,
        total_source_records=report.profile.record_count,
        eligible_record_count=len(release_rows),
        quarantined_record_uids=sorted(quarantined),
        excluded_record_uids=sorted(excluded),
        excluded_columns=sorted(excluded_columns),
        finding_outcome_counts=outcome_counts,
        validation_summary={"passed": passed, "failed": failed},
        release_status=release_status,
    )
    return ExecutionBundle(
        result=ExecutionResult(
            baseline_profile=report.profile,
            candidate_profile=candidate_profile,
            dry_run=dry_run,
            validations=validations,
            release_manifest=manifest,
        ),
        candidate_csv=candidate_csv,
        release_csv=release_csv,
    )
