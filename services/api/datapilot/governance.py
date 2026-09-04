"""Governance v2: dry run, change preview, execution, validations and the offline verifier.

AI proposes · Policy decides · Humans decide high-risk · Deterministic rules execute ·
Validations gate release. Nothing here knows a column name; scopes come from the report,
authorization from the contract and the human decisions, and every artifact is hashed.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import polars as pl

from datapilot.contracts.models import (
    AllowedAction,
    ApprovedAction,
    AuthorizationMode,
    ChangePreview,
    ChangePreviewItem,
    DecisionOutcome,
    DryRunReport,
    ExcludeColumnAction,
    ExcludeDuplicatesAction,
    ExecutionResult,
    Finding,
    FlagAction,
    HumanDecision,
    NormalizeCategoryAction,
    ProviderName,
    QuarantineAction,
    ReleaseManifest,
    ReleaseStatus,
    RunReport,
    StandardizeDateAction,
    ValidationResult,
    VerifyCheck,
    VerifyReport,
)
from datapilot.contracts.policy import (
    ContractError,
    DataContract,
    baseline_contract,
    contract_hash,
    parse_contract,
)
from datapilot.engine import (
    ENGINE_VERSION,
    AnalysisError,
    build_profile,
    dataset_hash,
    exact_duplicate_surplus,
    mask_value,
    parse_csv,
    record_uids,
)
from datapilot.engine.profile import overall_score
from datapilot.serialization import canonical_json

DEMO_REASON_ZH = {
    DecisionOutcome.APPROVE_PROPOSAL: "证据支持受限范围内的映射。",
    DecisionOutcome.QUARANTINE: "需人工复核，隔离后再处理。",
    DecisionOutcome.EXCLUDE: "敏感字段整列排除出发布。",
    DecisionOutcome.FLAG_FOR_REVIEW: "标记复核，保留在发布中。",
    DecisionOutcome.REJECT_PROPOSAL: "业务口径待确认，拒绝提议。",
}
_DEMO_PRIORITY = (
    DecisionOutcome.APPROVE_PROPOSAL,
    DecisionOutcome.EXCLUDE,
    DecisionOutcome.QUARANTINE,
    DecisionOutcome.FLAG_FOR_REVIEW,
    DecisionOutcome.REJECT_PROPOSAL,
)
_MEMBERSHIP_ORDER = {"QUARANTINED": 0, "EXCLUDED": 1, "FLAGGED": 2}
_TIME_DIRECTIVES = ("%H", "%M", "%S", "%f", "%I", "%p", "%z", "%Z", "%T", "%R")


class GovernanceError(ValueError):
    """Structured refusal; the API maps it to a 409 body with observed/expected side by side."""

    def __init__(
        self,
        code: str,
        message_zh: str,
        message_en: str,
        *,
        observed: Any = None,
        expected: Any = None,
    ) -> None:
        self.code = code
        self.message_zh = message_zh
        self.message_en = message_en
        self.observed = observed
        self.expected = expected
        super().__init__(f"{code}: {message_en}")


@dataclass(frozen=True)
class ExecutionBundle:
    result: ExecutionResult
    candidate_csv: bytes
    release_csv: bytes
    changes_jsonl: bytes


# --------------------------------------------------------------------------------------
# Hashes and helpers
# --------------------------------------------------------------------------------------


def action_set_hash(actions: list[ApprovedAction]) -> str:
    payload = [action.model_dump(mode="json") for action in actions]
    return hashlib.sha256(canonical_json(payload).encode()).hexdigest()


def decision_set_hash(decisions: list[HumanDecision]) -> str:
    """sha256 of the canonical JSON of the human decisions (sorted by finding id)."""
    payload = sorted(
        (decision.model_dump(mode="json") for decision in decisions),
        key=lambda item: str(item["finding_id"]),
    )
    return hashlib.sha256(canonical_json(payload).encode()).hexdigest()


def proposal_is_approvable(finding: Finding) -> bool:
    proposal = finding.proposal
    return (
        proposal is not None
        and proposal.grounding.valid
        and not proposal.abstained
        and bool(proposal.mapping)
    )


def needs_decision(finding: Finding) -> bool:
    return finding.authorization_mode not in (
        AuthorizationMode.POLICY_AUTHORIZED,
        AuthorizationMode.FORBIDDEN,
    )


def unresolved_findings(report: RunReport, decisions: dict[str, HumanDecision]) -> list[str]:
    return [
        finding.finding_id
        for finding in report.findings
        if needs_decision(finding) and finding.finding_id not in decisions
    ]


def demo_decisions(report: RunReport) -> list[HumanDecision]:
    """Derive one sensible decision per finding that needs one (used by the demo endpoints)."""
    decisions: list[HumanDecision] = []
    for finding in report.findings:
        if not needs_decision(finding):
            continue
        allowed = list(finding.allowed_outcomes)
        chosen: DecisionOutcome | None = None
        for outcome in _DEMO_PRIORITY:
            if outcome not in allowed:
                continue
            if outcome is DecisionOutcome.APPROVE_PROPOSAL and (
                finding.finding_type == "SEMANTIC_VARIANT" and not proposal_is_approvable(finding)
            ):
                continue
            chosen = outcome
            break
        if chosen is None:
            continue
        decisions.append(
            HumanDecision(
                finding_id=finding.finding_id,
                outcome=chosen,
                reason=DEMO_REASON_ZH[chosen],
                run_revision=report.run_revision,
            )
        )
    return decisions


def _load_decisions(raw: Any) -> list[HumanDecision]:
    if isinstance(raw, dict):
        return [HumanDecision.model_validate(value) for value in raw.values()]
    if isinstance(raw, list):
        return [HumanDecision.model_validate(value) for value in raw]
    return []


# --------------------------------------------------------------------------------------
# Dry run
# --------------------------------------------------------------------------------------


def _proposed_action(
    finding: Finding,
    contract: DataContract,
    *,
    source: str,
    ref: str,
) -> list[ApprovedAction]:
    """Actions for APPROVE_PROPOSAL / policy authorization of ``finding``."""
    action = finding.proposed_action
    if action is None:
        return []
    if action == "EXCLUDE_EXACT_DUPLICATE_FROM_RELEASE":
        return [
            ExcludeDuplicatesAction(
                action_type="EXCLUDE_EXACT_DUPLICATE_FROM_RELEASE",
                finding_id=finding.finding_id,
                record_uids=list(finding.record_uids),
                authorization_source=source,  # type: ignore[arg-type]
                authorization_ref=ref,
            )
        ]
    if action == "STANDARDIZE_DATE_FORMAT":
        target = str(finding.details.get("target_format", ""))
        formats = finding.details.get("source_formats")
        actions: list[ApprovedAction] = []
        if isinstance(formats, list) and formats:
            for entry in formats:
                if not isinstance(entry, dict):
                    continue
                uids = [str(uid) for uid in entry.get("record_uids", [])]
                if not uids:
                    continue
                actions.append(
                    StandardizeDateAction(
                        action_type="STANDARDIZE_DATE_FORMAT",
                        finding_id=finding.finding_id,
                        column=finding.column or "",
                        source_format=str(entry.get("format", "")),
                        target_format=target,
                        record_uids=uids,
                        authorization_source=source,  # type: ignore[arg-type]
                        authorization_ref=ref,
                    )
                )
        else:
            actions.append(
                StandardizeDateAction(
                    action_type="STANDARDIZE_DATE_FORMAT",
                    finding_id=finding.finding_id,
                    column=finding.column or "",
                    source_format=str(finding.details.get("source_format", "")),
                    target_format=target,
                    record_uids=list(finding.record_uids),
                    authorization_source=source,  # type: ignore[arg-type]
                    authorization_ref=ref,
                )
            )
        return actions
    if action == "NORMALIZE_CATEGORY":
        if finding.finding_type == "SEMANTIC_VARIANT":
            proposal = finding.proposal
            if proposal is None or proposal.mapping is None:
                return []
            mapping = dict(proposal.mapping)
        else:
            raw_mapping = finding.details.get("mapping")
            mapping = (
                {str(key): str(value) for key, value in raw_mapping.items()}
                if isinstance(raw_mapping, dict)
                else {}
            )
        if not mapping:
            return []
        return [
            NormalizeCategoryAction(
                action_type="NORMALIZE_CATEGORY",
                finding_id=finding.finding_id,
                column=finding.column or "",
                mapping=mapping,
                record_uids=list(finding.record_uids),
                authorization_source=source,  # type: ignore[arg-type]
                authorization_ref=ref,
            )
        ]
    if action == "QUARANTINE_RECORDS":
        return [
            QuarantineAction(
                action_type="QUARANTINE_RECORDS",
                finding_id=finding.finding_id,
                record_uids=list(finding.record_uids),
                authorization_source="HUMAN",
                authorization_ref=ref,
            )
        ]
    if action == "EXCLUDE_COLUMN_FROM_RELEASE":
        return [
            ExcludeColumnAction(
                action_type="EXCLUDE_COLUMN_FROM_RELEASE",
                finding_id=finding.finding_id,
                column=finding.column or "",
                authorization_source="HUMAN",
                authorization_ref=ref,
            )
        ]
    return []


def prepare_dry_run(
    report: RunReport,
    decisions: list[HumanDecision],
    contract: DataContract | None = None,
    *,
    run_revision: int = 1,
) -> DryRunReport:
    """Turn findings + decisions into a typed, hashed, not-yet-applied change set (spec §4)."""
    active = contract if contract is not None else baseline_contract()
    by_finding: dict[str, HumanDecision] = {}
    for item in decisions:
        if item.finding_id in by_finding:
            raise GovernanceError(
                "OUTCOME_NOT_ALLOWED",
                f"发现 {item.finding_id} 有多条处置决定。",
                f"Finding {item.finding_id} has more than one decision.",
                observed=item.finding_id,
            )
        by_finding[item.finding_id] = item
    actions: list[ApprovedAction] = []
    dispositions: dict[str, str] = {}
    unresolved: list[str] = []
    blocking_unresolved: list[str] = []
    policy_ref = f"{active.id}@{active.version}"

    for finding in report.findings:
        fid = finding.finding_id
        decision = by_finding.get(fid)
        if finding.authorization_mode is AuthorizationMode.FORBIDDEN:
            dispositions[fid] = "NOT_ACTIONABLE"
            continue
        if finding.authorization_mode is AuthorizationMode.POLICY_AUTHORIZED:
            if decision is not None and decision.outcome is DecisionOutcome.REJECT_PROPOSAL:
                dispositions[fid] = "PROPOSAL_REJECTED"
                if finding.blocking:
                    blocking_unresolved.append(fid)
                continue
            actions.extend(
                _proposed_action(finding, active, source="POLICY", ref=f"{policy_ref}:{fid}")
            )
            dispositions[fid] = "POLICY_ACTION_APPROVED"
            continue
        if decision is None:
            unresolved.append(fid)
            continue
        if decision.run_revision != run_revision:
            raise GovernanceError(
                "DECISION_REVISION_MISMATCH",
                f"发现 {fid} 的处置决定属于修订 {decision.run_revision}，当前为 {run_revision}。",
                f"The decision for {fid} belongs to revision {decision.run_revision}; "
                f"the run is at revision {run_revision}.",
                observed=decision.run_revision,
                expected=run_revision,
            )
        if decision.outcome not in finding.allowed_outcomes:
            raise GovernanceError(
                "OUTCOME_NOT_ALLOWED",
                f"发现 {fid} 不允许处置结果 {decision.outcome.value}。",
                f"Outcome {decision.outcome.value} is not allowed for finding {fid}.",
                observed=decision.outcome.value,
                expected=[outcome.value for outcome in finding.allowed_outcomes],
            )
        outcome = decision.outcome
        if outcome is DecisionOutcome.APPROVE_PROPOSAL:
            if finding.finding_type == "SEMANTIC_VARIANT":
                if not proposal_is_approvable(finding) or finding.proposal is None:
                    raise GovernanceError(
                        "OUTCOME_NOT_ALLOWED",
                        f"发现 {fid} 没有可批准的提议（提议为空或未通过接地校验）。",
                        f"Finding {fid} has no approvable proposal (missing or failed grounding).",
                        observed="APPROVE_PROPOSAL",
                        expected=["QUARANTINE", "REJECT_PROPOSAL"],
                    )
                ref = f"decision:{fid}@proposal:{finding.proposal.input_hash[:12]}"
            else:
                ref = f"decision:{fid}"
            produced = _proposed_action(finding, active, source="HUMAN", ref=ref)
            actions.extend(produced)
            dispositions[fid] = "HUMAN_ACTION_APPROVED"
        elif outcome is DecisionOutcome.QUARANTINE:
            actions.append(
                QuarantineAction(
                    action_type="QUARANTINE_RECORDS",
                    finding_id=fid,
                    record_uids=list(finding.record_uids),
                    authorization_source="HUMAN",
                    authorization_ref=f"decision:{fid}",
                )
            )
            dispositions[fid] = "QUARANTINED"
        elif outcome is DecisionOutcome.EXCLUDE:
            actions.append(
                ExcludeColumnAction(
                    action_type="EXCLUDE_COLUMN_FROM_RELEASE",
                    finding_id=fid,
                    column=finding.column or "",
                    authorization_source="HUMAN",
                    authorization_ref=f"decision:{fid}",
                )
            )
            dispositions[fid] = "EXCLUDED"
        elif outcome is DecisionOutcome.FLAG_FOR_REVIEW:
            actions.append(
                FlagAction(
                    action_type="FLAG_FOR_REVIEW",
                    finding_id=fid,
                    record_uids=list(finding.record_uids),
                    authorization_source="HUMAN",
                    authorization_ref=f"decision:{fid}",
                )
            )
            dispositions[fid] = "FLAGGED_FOR_REVIEW"
        else:
            dispositions[fid] = "PROPOSAL_REJECTED"
            if finding.blocking:
                blocking_unresolved.append(fid)

    if unresolved:
        raise GovernanceError(
            "UNRESOLVED_FINDINGS",
            f"{len(unresolved)} 项发现尚未处置：{', '.join(unresolved)}",
            f"{len(unresolved)} findings are unresolved: {', '.join(unresolved)}",
            observed=unresolved,
            expected=[],
        )

    quarantined: set[str] = set()
    duplicates: set[str] = set()
    flagged: set[str] = set()
    changed: set[str] = set()
    cells = 0
    excluded_columns: list[str] = []
    for action in actions:
        if isinstance(action, QuarantineAction):
            quarantined.update(action.record_uids)
        elif isinstance(action, ExcludeDuplicatesAction):
            duplicates.update(action.record_uids)
        elif isinstance(action, FlagAction):
            flagged.update(action.record_uids)
        elif isinstance(action, (NormalizeCategoryAction, StandardizeDateAction)):
            changed.update(action.record_uids)
            cells += len(action.record_uids)
        elif isinstance(action, ExcludeColumnAction) and action.column not in excluded_columns:
            excluded_columns.append(action.column)
    excluded = duplicates - quarantined
    flagged_in_release = flagged - quarantined - excluded
    removed = quarantined | excluded
    return DryRunReport(
        run_revision=run_revision,
        source_artifact_hash=report.profile.dataset_hash,
        approved_action_set_hash=action_set_hash(actions),
        actions=actions,
        finding_dispositions=dispositions,
        affected_record_count=len(changed | removed),
        affected_cell_count=cells,
        eligible_record_count=report.profile.record_count - len(removed),
        quarantined_record_count=len(quarantined),
        excluded_record_count=len(excluded),
        flagged_record_count=len(flagged_in_release),
        excluded_columns=sorted(excluded_columns),
        blocking_unresolved=blocking_unresolved,
        status="NOT_APPLIED",
        decision_set_hash=decision_set_hash(decisions),
    )


# --------------------------------------------------------------------------------------
# Applying actions (shared by preview and execute)
# --------------------------------------------------------------------------------------


@dataclass(frozen=True)
class _CellAuthorization:
    finding_id: str
    action_type: str
    authorization_source: str
    authorization_ref: str


@dataclass
class _Applied:
    frame: pl.DataFrame
    scope: dict[tuple[str, int], _CellAuthorization]
    quarantined: set[str]
    excluded: set[str]
    flagged: set[str]
    excluded_columns: list[str]


def _uses_time(fmt: str) -> bool:
    return any(directive in fmt for directive in _TIME_DIRECTIVES)


def _reformat(column: pl.Expr, source_format: str, target_format: str) -> pl.Expr:
    if _uses_time(source_format) or _uses_time(target_format):
        parsed = column.str.to_datetime(source_format, strict=False)
    else:
        parsed = column.str.to_date(source_format, strict=False)
    return pl.coalesce([parsed.dt.strftime(target_format), column])


def _apply_actions(frame: pl.DataFrame, dry_run: DryRunReport, uids: list[str]) -> _Applied:
    ordinal_by_uid = {uid: ordinal for ordinal, uid in enumerate(uids)}
    height = frame.height
    scope: dict[tuple[str, int], _CellAuthorization] = {}
    quarantined: set[str] = set()
    duplicates: set[str] = set()
    flagged: set[str] = set()
    excluded_columns: list[str] = []
    candidate = frame
    for action in dry_run.actions:
        if isinstance(action, (NormalizeCategoryAction, StandardizeDateAction)):
            if action.column not in candidate.columns:
                raise GovernanceError(
                    "ACTION_SET_CHANGED",
                    f"动作引用的列 `{action.column}` 不存在于源数据。",
                    f"Action references column `{action.column}` which is not in the source.",
                    observed=action.column,
                    expected=candidate.columns,
                )
            ordinals = [ordinal_by_uid[uid] for uid in action.record_uids if uid in ordinal_by_uid]
            if len(ordinals) != len(action.record_uids):
                raise GovernanceError(
                    "ACTION_SET_CHANGED",
                    f"动作 {action.finding_id} 引用了不属于该数据集的记录。",
                    f"Action {action.finding_id} references records that are not in this dataset.",
                )
            in_scope = pl.Series([False] * height, dtype=pl.Boolean)
            if ordinals:
                in_scope = in_scope.scatter(ordinals, True)
            column = pl.col(action.column)
            if isinstance(action, NormalizeCategoryAction):
                replaced = column.replace(action.mapping)
            else:
                replaced = _reformat(column, action.source_format, action.target_format)
            candidate = candidate.with_columns(
                pl.when(pl.lit(in_scope)).then(replaced).otherwise(column).alias(action.column)
            )
            authorization = _CellAuthorization(
                finding_id=action.finding_id,
                action_type=action.action_type,
                authorization_source=action.authorization_source,
                authorization_ref=action.authorization_ref,
            )
            for ordinal in ordinals:
                scope[(action.column, ordinal)] = authorization
        elif isinstance(action, QuarantineAction):
            quarantined.update(action.record_uids)
        elif isinstance(action, ExcludeDuplicatesAction):
            duplicates.update(action.record_uids)
        elif isinstance(action, FlagAction):
            flagged.update(action.record_uids)
        elif isinstance(action, ExcludeColumnAction) and action.column not in excluded_columns:
            excluded_columns.append(action.column)
    excluded = duplicates - quarantined
    return _Applied(
        frame=candidate,
        scope=scope,
        quarantined=quarantined,
        excluded=excluded,
        flagged=flagged - quarantined - excluded,
        excluded_columns=sorted(excluded_columns),
    )


def _changed_cells(source: pl.DataFrame, candidate: pl.DataFrame) -> dict[str, list[int]]:
    changed: dict[str, list[int]] = {}
    for column in source.columns:
        before = source.get_column(column)
        after = candidate.get_column(column)
        mask = before.ne_missing(after)
        if bool(mask.any()):
            changed[column] = [int(index) for index in mask.arg_true().to_list()]
    return changed


def _display_keys(
    frame: pl.DataFrame,
    contract: DataContract | None,
    withheld: set[str],
) -> list[str]:
    keys = list(contract.business_key) if contract is not None else []
    if keys and all(key in frame.columns for key in keys):
        parts = [frame.get_column(key).fill_null("").to_list() for key in keys]
        sensitive = withheld | (
            set(contract.sensitive_fields()) if contract is not None else set()
        )
        return [
            "|".join(
                mask_value(str(value)) if key in sensitive else str(value)
                for key, value in zip(keys, row, strict=True)
            )
            for row in zip(*parts, strict=True)
        ]
    return [str(ordinal) for ordinal in range(frame.height)]


def _masker(withheld: set[str]) -> Any:
    def mask(column: str, value: Any) -> str | None:
        if value is None:
            return None
        text = str(value)
        return mask_value(text) if column in withheld else text

    return mask


# --------------------------------------------------------------------------------------
# Preview
# --------------------------------------------------------------------------------------


def preview_changes(
    source: bytes,
    report: RunReport,
    dry_run: DryRunReport,
    limit: int = 50,
    *,
    contract: DataContract | None = None,
) -> ChangePreview:
    frame, _encoding = parse_csv(source)
    uids = record_uids(report.profile.dataset_hash, frame.height)
    applied = _apply_actions(frame, dry_run, uids)
    withheld = set(report.sensitive_preflight.columns_withheld)
    keys = _display_keys(frame, contract, withheld)
    mask = _masker(withheld)
    changes: list[ChangePreviewItem] = []
    total_cells = 0
    changed = _changed_cells(frame, applied.frame)
    cells = sorted(
        ((ordinal, column) for column, ordinals in changed.items() for ordinal in ordinals),
    )
    for ordinal, column in cells:
        total_cells += 1
        if len(changes) >= limit:
            continue
        authorization = applied.scope.get((column, ordinal))
        changes.append(
            ChangePreviewItem(
                record_uid=uids[ordinal],
                display_key=keys[ordinal],
                column=column,
                before=mask(column, frame.get_column(column)[ordinal]),
                after=mask(column, applied.frame.get_column(column)[ordinal]),
                finding_id=authorization.finding_id if authorization else "UNAPPROVED",
                action_type=(
                    AllowedAction(authorization.action_type)
                    if authorization
                    else AllowedAction.NORMALIZE_CATEGORY
                ),
            )
        )
    totals: dict[str, int] = {}
    for action in dry_run.actions:
        key = action.action_type
        if isinstance(action, ExcludeColumnAction):
            totals[key] = totals.get(key, 0) + 1
        else:
            totals[key] = totals.get(key, 0) + len(action.record_uids)
    totals["CHANGED_CELLS"] = total_cells
    totals["QUARANTINED_RECORDS"] = len(applied.quarantined)
    totals["EXCLUDED_RECORDS"] = len(applied.excluded)
    totals["FLAGGED_RECORDS"] = len(applied.flagged)
    totals["EXCLUDED_COLUMNS"] = len(applied.excluded_columns)
    return ChangePreview(changes=changes, totals=totals, truncated=total_cells > len(changes))


# --------------------------------------------------------------------------------------
# Execute
# --------------------------------------------------------------------------------------


def _validation(
    check_id: str,
    passed: bool,
    observed: Any,
    expected: Any,
    zh: str,
    en: str,
) -> ValidationResult:
    return ValidationResult(
        check_id=check_id,
        passed=passed,
        observed=observed,
        expected=expected,
        message_zh=zh,
        message_en=en,
    )


def _metric_numerator(report_metrics: Any, name: str) -> int | None:
    for metric in report_metrics:
        if metric.name == name:
            return int(metric.numerator)
    return None


def execute(
    source: bytes,
    contract: DataContract | None,
    report: RunReport,
    dry_run: DryRunReport,
    *,
    ai_call_count: int | None = None,
    ai_provider: ProviderName | str | None = None,
) -> ExecutionBundle:
    """Apply the approved change set to an in-memory copy of ``source`` and validate it.

    A source whose bytes differ from the dry run is still executed when it parses to the same
    record scope, so the ``SOURCE_IMMUTABLE`` validation fails visibly (tamper test); when it
    cannot be evaluated at all a ``GovernanceError`` is raised instead.
    """
    active = contract if contract is not None else baseline_contract()
    source_hash = dataset_hash(source)
    if action_set_hash(dry_run.actions) != dry_run.approved_action_set_hash:
        raise GovernanceError(
            "ACTION_SET_CHANGED",
            "已批准动作集在预演后被修改。",
            "The approved action set changed after the dry run.",
            observed=action_set_hash(dry_run.actions),
            expected=dry_run.approved_action_set_hash,
        )
    if dry_run.run_revision != report.run_revision:
        raise GovernanceError(
            "STALE_DRY_RUN",
            f"变更集属于修订 {dry_run.run_revision}，报告为修订 {report.run_revision}。",
            f"The change set is for revision {dry_run.run_revision}; the report is at "
            f"revision {report.run_revision}.",
            observed=dry_run.run_revision,
            expected=report.run_revision,
        )
    try:
        frame, encoding = parse_csv(source)
    except AnalysisError as error:
        raise GovernanceError(
            "SOURCE_ARTIFACT_CHANGED",
            f"源文件无法再解析（{error.code}），预演已失效。",
            f"The source can no longer be parsed ({error.code}); the dry run is invalid.",
            observed=source_hash,
            expected=dry_run.source_artifact_hash,
        ) from error
    if frame.height != report.profile.record_count or frame.columns != [
        profile.name for profile in report.column_profiles
    ]:
        raise GovernanceError(
            "SOURCE_ARTIFACT_CHANGED",
            "源文件的记录范围与报告不一致，无法执行。",
            "The source record scope no longer matches the report; refusing to execute.",
            observed=source_hash,
            expected=dry_run.source_artifact_hash,
        )
    uids = record_uids(report.profile.dataset_hash, frame.height)
    applied = _apply_actions(frame, dry_run, uids)
    candidate = applied.frame
    withheld = set(report.sensitive_preflight.columns_withheld)
    mask = _masker(withheld)
    keys = _display_keys(frame, active, withheld)

    # -- change ledger ---------------------------------------------------------------
    changed = _changed_cells(frame, candidate)
    changed_cells = sorted(
        (ordinal, column) for column, ordinals in changed.items() for ordinal in ordinals
    )
    ledger: list[dict[str, Any]] = []
    unapproved: list[tuple[int, str]] = []
    for ordinal, column in changed_cells:
        authorization = applied.scope.get((column, ordinal))
        if authorization is None:
            unapproved.append((ordinal, column))
        ledger.append(
            {
                "record_uid": uids[ordinal],
                "display_key": keys[ordinal],
                "column": column,
                "before": mask(column, frame.get_column(column)[ordinal]),
                "after": mask(column, candidate.get_column(column)[ordinal]),
                "action_type": authorization.action_type if authorization else "UNAPPROVED",
                "finding_id": authorization.finding_id if authorization else None,
                "authorization_source": (
                    authorization.authorization_source if authorization else None
                ),
                "authorization_ref": authorization.authorization_ref if authorization else None,
            }
        )
    membership_refs: dict[str, tuple[str, str, str, str]] = {}
    for action in dry_run.actions:
        if isinstance(action, QuarantineAction):
            status = "QUARANTINED"
        elif isinstance(action, ExcludeDuplicatesAction):
            status = "EXCLUDED"
        elif isinstance(action, FlagAction):
            status = "FLAGGED"
        else:
            continue
        for uid in action.record_uids:
            membership_refs.setdefault(
                f"{status}:{uid}",
                (
                    action.finding_id,
                    action.action_type,
                    action.authorization_source,
                    action.authorization_ref,
                ),
            )
    ordinal_by_uid = {uid: ordinal for ordinal, uid in enumerate(uids)}
    membership: list[tuple[int, str]] = []
    membership.extend((ordinal_by_uid[uid], "QUARANTINED") for uid in applied.quarantined)
    membership.extend((ordinal_by_uid[uid], "EXCLUDED") for uid in applied.excluded)
    membership.extend((ordinal_by_uid[uid], "FLAGGED") for uid in applied.flagged)
    membership.sort(key=lambda item: (_MEMBERSHIP_ORDER[item[1]], item[0]))
    for ordinal, status in membership:
        finding_id, action_type, auth_source, auth_ref = membership_refs.get(
            f"{status}:{uids[ordinal]}", ("", "", "", "")
        )
        ledger.append(
            {
                "record_uid": uids[ordinal],
                "display_key": keys[ordinal],
                "column": None,
                "before": None,
                "after": status,
                "action_type": action_type,
                "finding_id": finding_id,
                "authorization_source": auth_source,
                "authorization_ref": auth_ref,
            }
        )
    changes_jsonl = ("".join(canonical_json(record) + "\n" for record in ledger)).encode("utf-8")

    # -- artifacts -----------------------------------------------------------------------
    removed = applied.quarantined | applied.excluded
    keep = pl.Series([uid not in removed for uid in uids], dtype=pl.Boolean)
    release_columns = [
        column for column in candidate.columns if column not in applied.excluded_columns
    ]
    release_frame = candidate.filter(keep).select(release_columns)
    candidate_csv = candidate.write_csv().encode("utf-8")
    release_csv = release_frame.write_csv().encode("utf-8")
    candidate_hash = hashlib.sha256(candidate_csv).hexdigest()
    release_hash = hashlib.sha256(release_csv).hexdigest()
    ledger_hash = hashlib.sha256(changes_jsonl).hexdigest()

    candidate_profile = build_profile(
        candidate,
        active,
        report.profile.dataset_hash,
        uids,
        exact_surplus=int(exact_duplicate_surplus(candidate).sum()),
        key_surplus=0,
        source_encoding=encoding,
    )
    # Business-key surplus is a property of the source scope; keep the report's value.
    baseline_unique = next((m for m in report.profile.metrics if m.name == "uniqueness"), None)
    if baseline_unique is not None:
        candidate_metrics = [
            baseline_unique if metric.name == "uniqueness" else metric
            for metric in candidate_profile.metrics
        ]
        candidate_profile = candidate_profile.model_copy(
            update={
                "metrics": candidate_metrics,
                "overall_score": overall_score(candidate_metrics, active),
            }
        )

    # -- validations ---------------------------------------------------------------------
    release_uids = {uid for uid, kept in zip(uids, keep.to_list(), strict=True) if kept}
    baseline_completeness = _metric_numerator(report.profile.metrics, "completeness")
    candidate_completeness = _metric_numerator(candidate_profile.metrics, "completeness")
    conflict_findings = [
        finding
        for finding in report.findings
        if finding.finding_type == "SEMANTIC_CONFLICT" and finding.column is not None
    ]
    conflict_changed = 0
    for finding in conflict_findings:
        column = finding.column or ""
        for uid in finding.record_uids:
            position = ordinal_by_uid.get(uid)
            if position is None:
                conflict_changed += 1
                continue
            if frame.get_column(column)[position] != candidate.get_column(column)[position]:
                conflict_changed += 1
    membership_count = len(membership)
    expected_membership = (
        dry_run.quarantined_record_count
        + dry_run.excluded_record_count
        + dry_run.flagged_record_count
    )
    recomputed_action_hash = action_set_hash(dry_run.actions)
    manifest_hashes_recomputed = (
        hashlib.sha256(candidate_csv).hexdigest() == candidate_hash
        and hashlib.sha256(release_csv).hexdigest() == release_hash
        and hashlib.sha256(changes_jsonl).hexdigest() == ledger_hash
    )
    validations = [
        _validation(
            "SOURCE_IMMUTABLE",
            source_hash == report.profile.dataset_hash == dry_run.source_artifact_hash,
            source_hash,
            report.profile.dataset_hash,
            "源文件哈希与分析时一致。",
            "The source artifact hash is unchanged since analysis.",
        ),
        _validation(
            "SCOPE_STABLE",
            candidate_profile.scope_hash == report.profile.scope_hash,
            candidate_profile.scope_hash,
            report.profile.scope_hash,
            "候选质量评估使用与源相同的记录范围。",
            "Candidate quality uses the source record scope.",
        ),
        _validation(
            "EVALUATION_SCOPE_STABLE",
            candidate_profile.evaluation_scope_hash == report.profile.evaluation_scope_hash,
            candidate_profile.evaluation_scope_hash,
            report.profile.evaluation_scope_hash,
            "质量对比使用相同的字段、契约与评分版本。",
            "Quality comparison uses the same fields, contract and score version.",
        ),
        _validation(
            "COMPLETENESS_NOT_IMPUTED",
            baseline_completeness == candidate_completeness,
            candidate_completeness,
            baseline_completeness,
            "必填字段的非空计数没有变化（未填补任何缺失值）。",
            "Required-field non-empty counts are unchanged (nothing was imputed).",
        ),
        _validation(
            "NO_UNAPPROVED_CELL_CHANGES",
            not unapproved and len(changed_cells) == len(applied.scope),
            len(changed_cells),
            len(applied.scope),
            "变更的单元格恰好等于已批准归一/日期动作的范围。",
            "Changed cells equal exactly the union of approved normalize/date action scopes.",
        ),
        _validation(
            "CONFLICTS_UNCHANGED",
            conflict_changed == 0,
            conflict_changed,
            0,
            f"{len(conflict_findings)} 个冲突发现的记录在其列上保持不变。",
            f"Records of {len(conflict_findings)} conflict finding(s) are unchanged in their "
            f"column.",
        ),
        _validation(
            "QUARANTINE_EXCLUDED",
            applied.quarantined.isdisjoint(release_uids)
            and len(applied.quarantined) == dry_run.quarantined_record_count,
            len(applied.quarantined),
            dry_run.quarantined_record_count,
            "隔离记录不在发布工件中。",
            "Quarantined records are absent from the release artifact.",
        ),
        _validation(
            "DUPLICATES_EXCLUDED",
            applied.excluded.isdisjoint(release_uids)
            and len(applied.excluded) == dry_run.excluded_record_count,
            len(applied.excluded),
            dry_run.excluded_record_count,
            "仅已授权的多余重复记录被排除。",
            "Only the authorized surplus duplicate occurrences were excluded.",
        ),
        _validation(
            "SENSITIVE_COLUMN_EXCLUDED",
            not set(applied.excluded_columns) & set(release_columns)
            and applied.excluded_columns == list(dry_run.excluded_columns),
            applied.excluded_columns,
            list(dry_run.excluded_columns),
            "已批准排除的列不在发布工件中。",
            "Approved excluded columns are absent from the release artifact.",
        ),
        _validation(
            "ROW_RECONCILIATION",
            release_frame.height == dry_run.eligible_record_count
            and release_frame.height + len(removed) == report.profile.record_count,
            release_frame.height,
            dry_run.eligible_record_count,
            "总记录 = 可发布 + 隔离 + 排除。",
            "Total records = eligible + quarantined + excluded.",
        ),
        _validation(
            "FINDING_CONSERVATION",
            len(dry_run.finding_dispositions) == len(report.findings)
            and set(dry_run.finding_dispositions) == {f.finding_id for f in report.findings},
            len(dry_run.finding_dispositions),
            len(report.findings),
            "每个发现都恰好有一个处置。",
            "Every finding has exactly one disposition.",
        ),
        _validation(
            "ACTION_SET_HASH_MATCH",
            recomputed_action_hash == dry_run.approved_action_set_hash,
            recomputed_action_hash,
            dry_run.approved_action_set_hash,
            "执行的动作集哈希与预演一致。",
            "The executed action set hash matches the dry run.",
        ),
        _validation(
            "CHANGE_LEDGER_RECONCILES",
            len(changed_cells) == dry_run.affected_cell_count
            and membership_count == expected_membership,
            {"cells": len(changed_cells), "memberships": membership_count},
            {"cells": dry_run.affected_cell_count, "memberships": expected_membership},
            "变更台账的单元格记录数与成员记录数均与预演一致。",
            "Change-ledger cell and membership records reconcile with the dry run.",
        ),
        _validation(
            "MANIFEST_HASHES_RECOMPUTED",
            manifest_hashes_recomputed,
            {"candidate": candidate_hash, "release": release_hash, "changes": ledger_hash},
            {"candidate": candidate_hash, "release": release_hash, "changes": ledger_hash},
            "候选、发布与变更台账的哈希已重新计算并一致。",
            "Candidate, release and change-ledger hashes were recomputed and agree.",
        ),
    ]
    passed = sum(1 for validation in validations if validation.passed)
    failed = len(validations) - passed
    if failed or dry_run.blocking_unresolved:
        release_status = ReleaseStatus.BLOCKED
    elif not removed and not applied.excluded_columns:
        release_status = ReleaseStatus.PASS
    else:
        release_status = ReleaseStatus.CONDITIONAL_PASS

    outcome_counts: dict[str, int] = {}
    for disposition in dry_run.finding_dispositions.values():
        outcome_counts[disposition] = outcome_counts.get(disposition, 0) + 1
    proposals = [finding for finding in report.findings if finding.proposal is not None]
    if ai_provider is None:
        live = [
            finding.proposal.provider
            for finding in proposals
            if finding.proposal is not None
            and finding.proposal.provider is not ProviderName.DETERMINISTIC
        ]
        provider_value: ProviderName | str = live[0] if live else ProviderName.DETERMINISTIC
    else:
        provider_value = ai_provider
    call_count = (
        ai_call_count
        if ai_call_count is not None
        else sum(1 for finding in proposals if finding.proposal and finding.proposal.ledger_call_id)
    )
    hash_value = contract_hash(active)
    manifest = ReleaseManifest(
        source_artifact_hash=report.profile.dataset_hash,
        candidate_artifact_hash=candidate_hash,
        release_artifact_hash=release_hash,
        policy_pack_hash=hash_value,
        contract_hash=hash_value,
        engine_version=ENGINE_VERSION,
        score_version=report.profile.score_version,
        scope_hash=report.profile.scope_hash,
        total_source_records=report.profile.record_count,
        eligible_record_count=release_frame.height,
        quarantined_record_uids=sorted(applied.quarantined),
        excluded_record_uids=sorted(applied.excluded),
        flagged_record_uids=sorted(applied.flagged),
        excluded_columns=applied.excluded_columns,
        finding_outcome_counts=outcome_counts,
        validation_summary={"passed": passed, "failed": failed},
        release_status=release_status,
        ai_call_count=call_count,
        ai_provider=provider_value,  # type: ignore[arg-type]
        decision_set_hash=dry_run.decision_set_hash,
        change_ledger_hash=ledger_hash,
        ai_input_hashes={
            finding.finding_id: finding.proposal.input_hash
            for finding in proposals
            if finding.proposal is not None
        },
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
        changes_jsonl=changes_jsonl,
    )


# --------------------------------------------------------------------------------------
# Offline verifier
# --------------------------------------------------------------------------------------


def _check(check_id: str, observed: Any, expected: Any, zh: str, en: str) -> VerifyCheck:
    return VerifyCheck(
        check_id=check_id,
        passed=observed == expected,
        observed=observed,
        expected=expected,
        message_zh=zh,
        message_en=en,
    )


def _file_sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def verify_run(run_dir: Path) -> VerifyReport:
    """Recompute every hash in a run directory and re-run ``execute`` in memory (spec §4)."""
    run_dir = Path(run_dir)
    checks: list[VerifyCheck] = []
    report_path = run_dir / "report.json"
    source_path = run_dir / "source.csv"
    if not report_path.exists() or not source_path.exists():
        checks.append(
            _check(
                "RUN_FILES_PRESENT",
                sorted(path.name for path in (report_path, source_path) if path.exists()),
                ["report.json", "source.csv"],
                "运行目录缺少 report.json 或 source.csv。",
                "The run directory lacks report.json or source.csv.",
            )
        )
        return VerifyReport(ok=False, checks=checks)
    report = RunReport.model_validate_json(report_path.read_text(encoding="utf-8"))
    source = source_path.read_bytes()
    checks.append(
        _check(
            "SOURCE_HASH",
            dataset_hash(source),
            report.profile.dataset_hash,
            "source.csv 的 sha256 与报告中的 dataset_hash 一致。",
            "sha256(source.csv) equals report.dataset_hash.",
        )
    )
    contract: DataContract | None = None
    contract_path = run_dir / "contract.yaml"
    if contract_path.exists():
        try:
            contract = parse_contract(contract_path.read_text(encoding="utf-8"))
            observed_contract = contract_hash(contract)
        except ContractError as error:
            observed_contract = f"unparseable:{error.code}"
        checks.append(
            _check(
                "CONTRACT_HASH",
                observed_contract,
                report.contract.hash,
                "contract.yaml 的规范哈希与报告一致。",
                "The canonical hash of contract.yaml equals report.contract.hash.",
            )
        )
    else:
        contract = baseline_contract()
        checks.append(
            _check(
                "CONTRACT_HASH",
                contract_hash(contract),
                report.contract.hash,
                "无 contract.yaml：基线契约哈希与报告一致。",
                "No contract.yaml: the baseline contract hash equals report.contract.hash.",
            )
        )
    dry_run: DryRunReport | None = None
    dry_run_path = run_dir / "dry-run.json"
    execution: ExecutionResult | None = None
    execution_path = run_dir / "execution.json"
    if execution_path.exists():
        execution = ExecutionResult.model_validate_json(execution_path.read_text(encoding="utf-8"))
    if dry_run_path.exists():
        dry_run = DryRunReport.model_validate_json(dry_run_path.read_text(encoding="utf-8"))
    elif execution is not None:
        dry_run = execution.dry_run
    if dry_run is None:
        return VerifyReport(ok=all(check.passed for check in checks), checks=checks)
    checks.append(
        _check(
            "ACTION_SET_HASH",
            action_set_hash(dry_run.actions),
            dry_run.approved_action_set_hash,
            "动作集重新哈希后与预演一致。",
            "Re-hashing the actions reproduces approved_action_set_hash.",
        )
    )
    decisions_path = run_dir / "decisions.json"
    if decisions_path.exists():
        decisions = _load_decisions(json.loads(decisions_path.read_text(encoding="utf-8")))
        checks.append(
            _check(
                "DECISION_SET_HASH",
                decision_set_hash(decisions),
                dry_run.decision_set_hash,
                "decisions.json 重新哈希后与预演一致。",
                "Re-hashing decisions.json reproduces decision_set_hash.",
            )
        )
    if execution is None:
        return VerifyReport(ok=all(check.passed for check in checks), checks=checks)
    manifest = execution.release_manifest
    manifest_path = run_dir / "release-manifest.json"
    if manifest_path.exists():
        stored = ReleaseManifest.model_validate_json(manifest_path.read_text(encoding="utf-8"))
        checks.append(
            _check(
                "MANIFEST_MATCHES_EXECUTION",
                stored.model_dump(mode="json"),
                manifest.model_dump(mode="json"),
                "release-manifest.json 与 execution.json 中的清单一致。",
                "release-manifest.json equals the manifest inside execution.json.",
            )
        )
    for name, expected, zh, en in (
        (
            "candidate.csv",
            manifest.candidate_artifact_hash,
            "candidate.csv 的 sha256 与清单一致。",
            "sha256(candidate.csv) equals the manifest.",
        ),
        (
            "release.csv",
            manifest.release_artifact_hash,
            "release.csv 的 sha256 与清单一致。",
            "sha256(release.csv) equals the manifest.",
        ),
        (
            "changes.jsonl",
            manifest.change_ledger_hash,
            "changes.jsonl 的 sha256 与清单一致。",
            "sha256(changes.jsonl) equals the manifest.",
        ),
    ):
        path = run_dir / name
        checks.append(
            _check(
                f"{name.split('.')[0].upper().replace('-', '_')}_HASH",
                _file_sha256(path) if path.exists() else "missing",
                expected,
                zh,
                en,
            )
        )
    try:
        bundle = execute(source, contract, report, dry_run)
        observed_release: Any = bundle.result.release_manifest.release_artifact_hash
        observed_validations: Any = [
            (validation.check_id, validation.passed) for validation in bundle.result.validations
        ]
    except GovernanceError as error:
        observed_release = f"refused:{error.code}"
        observed_validations = f"refused:{error.code}"
    checks.append(
        _check(
            "REEXECUTION_RELEASE_HASH",
            observed_release,
            manifest.release_artifact_hash,
            "内存中重新执行得到相同的发布哈希。",
            "Re-executing in memory reproduces the release hash.",
        )
    )
    checks.append(
        _check(
            "REEXECUTION_VALIDATIONS",
            observed_validations,
            [(validation.check_id, validation.passed) for validation in execution.validations],
            "内存中重新执行得到相同的验证结果。",
            "Re-executing in memory reproduces the validation results.",
        )
    )
    return VerifyReport(ok=all(check.passed for check in checks), checks=checks)
