"""DataPilot engine v2: ``analyze_csv`` and its building blocks (spec §3).

The engine works on any UTF-8/GB18030 CSV within limits, with or without a Data Contract.
It never calls a model itself: the semantic step is delegated to a ``SemanticResolver``
(implemented by ``datapilot.ai``) and falls back to a deterministic normalize-match.
"""

from __future__ import annotations

import time
from pathlib import Path

import polars as pl

from datapilot.contracts.models import (
    ContractInfo,
    ContractSource,
    Finding,
    ReleaseStatus,
    RunReport,
    SensitivePreflight,
)
from datapilot.contracts.policy import (
    ContractError,
    DataContract,
    baseline_contract,
    contract_hash,
    parse_contract,
)
from datapilot.engine.detectors import (
    SEM_CANDIDATE_LIMIT,
    DetectionContext,
    SemanticResolver,
    deterministic_mapping,
    deterministic_proposal,
    exact_duplicate_surplus,
    run_detectors,
    semantic_candidate_values,
    semantic_request_hash,
)
from datapilot.engine.parse import (
    MAX_COLUMNS,
    MAX_ROWS,
    MAX_UPLOAD_BYTES,
    AnalysisError,
    ParsedCsv,
    dataset_hash,
    parse_csv,
    parse_csv_detailed,
    record_uid,
    record_uids,
)
from datapilot.engine.profile import (
    ColumnStats,
    build_column_profiles,
    build_profile,
    compute_column_stats,
    normalize_text,
)
from datapilot.engine.sensitive import (
    HEURISTIC_NAME_TOKENS,
    SENSITIVE_PATTERNS,
    classify_value,
    heuristic_sensitive_columns,
    mask_value,
)

ENGINE_VERSION = "0.2.0"

__all__ = [
    "ENGINE_VERSION",
    "HEURISTIC_NAME_TOKENS",
    "MAX_COLUMNS",
    "MAX_ROWS",
    "MAX_UPLOAD_BYTES",
    "SEM_CANDIDATE_LIMIT",
    "SENSITIVE_PATTERNS",
    "AnalysisError",
    "ColumnStats",
    "ParsedCsv",
    "SemanticResolver",
    "analyze_csv",
    "baseline_policy",
    "build_profile",
    "classify_value",
    "compute_column_stats",
    "dataset_hash",
    "deterministic_mapping",
    "deterministic_proposal",
    "exact_duplicate_surplus",
    "heuristic_sensitive_columns",
    "load_policy",
    "mask_value",
    "normalize_text",
    "parse_csv",
    "parse_csv_detailed",
    "record_uid",
    "record_uids",
    "semantic_candidates",
    "semantic_request_hash",
    "withheld_columns",
]


def baseline_policy() -> DataContract:
    """Compatibility name: the observational baseline contract."""
    return baseline_contract()


def load_policy(path: Path) -> DataContract:
    """Parse a v1 Policy Pack or v2 Data Contract file into a ``DataContract``."""
    try:
        return parse_contract(Path(path).read_text(encoding="utf-8"))
    except ContractError as error:
        raise AnalysisError(error.code, error.message_zh, error.message_en) from error
    except OSError as error:
        raise AnalysisError(
            "CONTRACT_UNREADABLE",
            f"无法读取契约文件：{path}",
            f"Contract file could not be read: {path}",
        ) from error


def withheld_columns(stats: list[ColumnStats], contract: DataContract) -> set[str]:
    """Columns whose values never reach the AI or the UI unmasked."""
    declared = set(contract.sensitive_fields())
    return declared | {column.name for column in stats if column.sensitive.hit_count > 0}


def semantic_candidates(frame: pl.DataFrame, contract: DataContract) -> dict[str, int]:
    """``{column: candidate_count}`` for every semantic column that would get an AI request."""
    if contract.is_observational:
        return {}
    stats = {column.name: column for column in compute_column_stats(frame)}
    withheld = withheld_columns(list(stats.values()), contract)
    result: dict[str, int] = {}
    for column in contract.semantic_columns():
        if column not in stats or column in withheld:
            continue
        candidates, _truncated = semantic_candidate_values(stats[column], contract, column)
        if candidates:
            result[column] = len(candidates)
    return result


def _release_status(contract: DataContract, findings: list[Finding]) -> ReleaseStatus:
    if contract.is_observational:
        return ReleaseStatus.NOT_EVALUATED
    if any(finding.blocking for finding in findings):
        return ReleaseStatus.BLOCKED
    return ReleaseStatus.CONDITIONAL_PASS


def analyze_csv(
    content: bytes,
    contract: DataContract | None = None,
    *,
    synthetic: bool = False,
    fixture_version: str | None = None,
    ai: SemanticResolver | None = None,
    run_revision: int = 1,
    run_id: str | None = None,
    contract_source: ContractSource | str = ContractSource.UPLOADED,
) -> RunReport:
    """Profile, detect and (optionally) semantically assess ``content``.

    Raises ``AnalysisError`` for anything outside the parsing limits. Never raises because
    of the resolver: any semantic failure degrades to the deterministic fallback and is
    reported in ``warnings_zh/warnings_en`` and on the finding.
    """
    active = contract if contract is not None else baseline_contract()
    is_baseline = (
        contract is None or active.is_observational and active.id == baseline_contract().id
    )
    source = ContractSource.BASELINE if is_baseline else ContractSource(contract_source)

    started = time.perf_counter()
    frame, delimiter, encoding = parse_csv_detailed(content)
    parse_ms = int((time.perf_counter() - started) * 1000)

    started = time.perf_counter()
    digest = dataset_hash(content)
    uids = record_uids(digest, frame.height)
    stats_list = compute_column_stats(frame)
    stats = {column.name: column for column in stats_list}
    withheld = withheld_columns(stats_list, active)
    surplus = exact_duplicate_surplus(frame)
    profile_ms = int((time.perf_counter() - started) * 1000)

    started = time.perf_counter()
    ctx = DetectionContext(
        frame=frame,
        contract=active,
        stats=stats,
        uids=uids,
        withheld=withheld,
        resolver=ai,
        run_id=run_id,
        exact_surplus=surplus,
    )
    findings = run_detectors(ctx)
    detect_ms = max(int((time.perf_counter() - started) * 1000) - ctx.semantic_ms, 0)

    started = time.perf_counter()
    profile = build_profile(
        frame,
        active,
        digest,
        uids,
        stats=stats_list,
        exact_surplus=int(surplus.sum()),
        key_surplus=ctx.key_surplus,
        source_encoding=encoding,
    )
    column_profiles = build_column_profiles(stats_list, active, withheld)
    profile_ms += int((time.perf_counter() - started) * 1000)

    warnings_zh = list(ctx.warnings_zh)
    warnings_en = list(ctx.warnings_en)
    if active.is_observational:
        warnings_zh.insert(0, "未提供数据契约；结果仅为观测，不进行发布评估。")
        warnings_en.insert(
            0,
            "No Data Contract supplied; results are observational only and no release is "
            "evaluated.",
        )
    cells_masked = sum(stats[column].non_empty for column in withheld if column in stats)
    release_status = _release_status(active, findings)
    return RunReport(
        schema_version="2.0",
        engine_version=ENGINE_VERSION,
        fixture_version=fixture_version,
        synthetic=synthetic,
        profile=profile,
        column_profiles=column_profiles,
        contract=ContractInfo(
            id=active.id,
            version=active.version,
            hash=contract_hash(active),
            source=source,
            field_count=active.field_count,
        ),
        sensitive_preflight=SensitivePreflight(
            columns_withheld=sorted(withheld, key=lambda name: frame.columns.index(name)),
            cells_masked=cells_masked,
        ),
        findings=findings,
        release_status=release_status,
        finding_outcome_counts={"OPEN": len(findings)},
        timings_ms={
            "parse": parse_ms,
            "profile": profile_ms,
            "detect": detect_ms,
            "semantic": ctx.semantic_ms,
        },
        warnings_zh=warnings_zh,
        warnings_en=warnings_en,
        run_revision=run_revision,
    )
