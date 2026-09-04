"""Contract-driven detectors (spec §3.5).

Finding ids are ``<TYPE>-<column>`` so they are stable and generic. No detector knows any
column name or value; everything comes from the ``DataContract`` and the observed data.
The semantic step is pluggable through ``SemanticResolver``; the engine never calls a model.
"""

from __future__ import annotations

import hashlib
import time
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from typing import Any, Protocol

import polars as pl

from datapilot.contracts.models import (
    AIProposal,
    AIProposalSummary,
    AllowedAction,
    AuthorizationMode,
    DecisionOutcome,
    EvidenceSignal,
    Finding,
    GroundingResult,
    ProviderName,
    RiskLevel,
    SemanticRequest,
)
from datapilot.contracts.policy import DataContract, FieldRule
from datapilot.engine.profile import (
    DEFAULT_DATE_FORMAT,
    DEFAULT_DATETIME_FORMAT,
    PATTERN_DMY_SLASH,
    PATTERN_FORMATS,
    PATTERN_MDY_SLASH,
    PATTERN_YMD_COMPACT,
    PATTERN_YMD_DASH,
    PATTERN_YMD_SLASH,
    ColumnStats,
    constraint_violations,
    format_masks,
    normalize_text,
    type_mask,
)
from datapilot.engine.sensitive import (
    classify_value,
    is_heuristic_sensitive_name,
)
from datapilot.serialization import canonical_json

SEM_CANDIDATE_LIMIT = 30
SEM_CANDIDATE_MAX_CHARS = 64
SAMPLE_UID_LIMIT = 20
OBSERVATIONAL_ISO_SHARE = 0.90
DETERMINISTIC_MODEL = "normalize-match"
DETERMINISTIC_PROMPT_VERSION = "deterministic-1.0"

EVID_VOCAB = "EVID-VOCAB-01"
EVID_COUNTS = "EVID-COUNTS-02"
EVID_AMBIGUITY = "EVID-AMBIGUITY-03"
EVID_CONSISTENCY = "EVID-CONSISTENCY-04"

_OBSERVATIONAL_ALTERNATES = (
    PATTERN_YMD_SLASH,
    PATTERN_DMY_SLASH,
    PATTERN_MDY_SLASH,
    PATTERN_YMD_COMPACT,
)


class SemanticResolver(Protocol):
    """What the engine calls once per ``SEM-<col>`` finding (implemented by ``datapilot.ai``)."""

    def resolve(
        self, request: SemanticRequest, *, run_id: str
    ) -> tuple[AIProposal, GroundingResult, str | None]: ...


# --------------------------------------------------------------------------------------
# Deterministic semantic fallback (spec §3.5)
# --------------------------------------------------------------------------------------


def semantic_request_hash(request: SemanticRequest) -> str:
    return hashlib.sha256(canonical_json(request.model_dump(mode="json")).encode()).hexdigest()


def deterministic_mapping(
    candidates: Iterable[str],
    targets: Iterable[str],
    alias_map: Mapping[str, str],
) -> dict[str, str]:
    """Map a candidate only when ``normalize(candidate) == normalize(target or alias)``."""
    by_norm: dict[str, str] = {}
    for canonical in targets:
        by_norm.setdefault(normalize_text(canonical), canonical)
    for alias, target in alias_map.items():
        by_norm.setdefault(normalize_text(alias), target)
    mapping: dict[str, str] = {}
    for candidate in candidates:
        matched = by_norm.get(normalize_text(candidate))
        if matched is not None and matched != candidate:
            mapping[candidate] = matched
    return mapping


def deterministic_proposal(
    request: SemanticRequest,
    alias_map: Mapping[str, str] | None = None,
) -> AIProposal:
    """Schema-identical proposal produced without any model; labelled ``deterministic``."""
    mapping = deterministic_mapping(
        request.candidate_counts, request.canonical_vocabulary, alias_map or {}
    )
    mapping = {
        source: target
        for source, target in mapping.items()
        if source not in request.ambiguity_tokens and target in request.canonical_vocabulary
    }
    return AIProposal(
        finding_id=request.finding_id,
        proposed_action="NORMALIZE_CATEGORY" if mapping else None,
        column=request.column,
        mapping=mapping or None,
        evidence_refs=[ref for ref in (EVID_VOCAB, EVID_COUNTS) if ref in request.evidence_refs],
        semantic_explanation=(
            "Deterministic fallback: candidates whose normalized text equals a canonical "
            "target or alias are mapped; nothing else is."
        ),
        ambiguity_flags=[],
        abstained=not mapping,
        abstain_reason=None
        if mapping
        else "No candidate matched a canonical term after normalization.",
        provider=ProviderName.DETERMINISTIC.value,
        model=DETERMINISTIC_MODEL,
        prompt_version=DETERMINISTIC_PROMPT_VERSION,
        input_hash=semantic_request_hash(request),
    )


# --------------------------------------------------------------------------------------
# Detection context and helpers
# --------------------------------------------------------------------------------------


@dataclass
class DetectionContext:
    frame: pl.DataFrame
    contract: DataContract
    stats: dict[str, ColumnStats]
    uids: list[str]
    withheld: set[str]
    resolver: SemanticResolver | None
    run_id: str | None
    exact_surplus: pl.Series
    warnings_zh: list[str] = field(default_factory=list)
    warnings_en: list[str] = field(default_factory=list)
    key_surplus: int = 0
    semantic_ms: int = 0

    @property
    def observational(self) -> bool:
        return self.contract.is_observational

    def warn(self, zh: str, en: str) -> None:
        self.warnings_zh.append(zh)
        self.warnings_en.append(en)

    def uids_for(self, mask: pl.Series) -> list[str]:
        return [self.uids[int(index)] for index in mask.fill_null(False).arg_true().to_list()]

    def rows_with(self, column: str, values: list[str]) -> pl.Series:
        if not values:
            return pl.Series([False] * self.frame.height, dtype=pl.Boolean)
        return self.frame.get_column(column).is_in(values).fill_null(False)


def _signal(
    signal: str,
    status: str,
    zh: str,
    en: str,
    ref: str,
) -> EvidenceSignal:
    return EvidenceSignal(
        signal=signal,
        status=status,  # type: ignore[arg-type]
        explanation_zh=zh,
        explanation_en=en,
        evidence_ref=ref,
    )


def _finding(
    *,
    finding_id: str,
    finding_type: str,
    title_zh: str,
    title_en: str,
    explanation_zh: str,
    explanation_en: str,
    column: str | None,
    record_uids: list[str],
    risk: RiskLevel,
    blocking: bool,
    authorization: AuthorizationMode,
    action: AllowedAction | None,
    allowed_outcomes: list[DecisionOutcome],
    signals: list[EvidenceSignal],
    details: dict[str, Any],
    cell_count: int | None = None,
    proposal: AIProposalSummary | None = None,
) -> Finding:
    return Finding(
        finding_id=finding_id,
        finding_type=finding_type,
        title_zh=title_zh,
        title_en=title_en,
        explanation_zh=explanation_zh,
        explanation_en=explanation_en,
        column=column,
        affected_record_count=len(record_uids),
        affected_cell_count=len(record_uids) if cell_count is None else cell_count,
        risk_level=risk,
        blocking=blocking,
        authorization_mode=authorization,
        proposed_action=action,
        allowed_outcomes=allowed_outcomes,
        disposition="OPEN",
        evidence_signals=signals,
        record_uids=record_uids,
        sample_record_uids=record_uids[:SAMPLE_UID_LIMIT],
        details=details,
        proposal=proposal,
    )


def _n(value: int) -> str:
    return f"{value:,}"


def _join(values: Iterable[str], limit: int = 6) -> str:
    items = list(values)
    shown = ", ".join(items[:limit])
    return shown + (" …" if len(items) > limit else "")


# --------------------------------------------------------------------------------------
# Duplicates
# --------------------------------------------------------------------------------------


def exact_duplicate_surplus(frame: pl.DataFrame) -> pl.Series:
    """True for every occurrence after the first of an all-column identical row."""
    first = frame.select(pl.struct(pl.all()).is_first_distinct().alias("f")).get_column("f")
    return ~first


def detect_duplicates(ctx: DetectionContext) -> list[Finding]:
    findings: list[Finding] = []
    surplus = ctx.exact_surplus
    surplus_count = int(surplus.sum())
    if surplus_count:
        duplicated = ctx.frame.select(pl.struct(pl.all()).is_duplicated().alias("d")).get_column(
            "d"
        )
        group_count = int((duplicated & ~surplus).sum())
        if ctx.observational:
            authorization, action, outcomes = AuthorizationMode.FORBIDDEN, None, []
        elif ctx.contract.auto_authorization.exact_duplicate_exclusion:
            authorization = AuthorizationMode.POLICY_AUTHORIZED
            action = AllowedAction.EXCLUDE_EXACT_DUPLICATE_FROM_RELEASE
            outcomes = [DecisionOutcome.APPROVE_PROPOSAL, DecisionOutcome.REJECT_PROPOSAL]
        else:
            authorization = AuthorizationMode.HUMAN_APPROVAL_REQUIRED
            action = AllowedAction.EXCLUDE_EXACT_DUPLICATE_FROM_RELEASE
            outcomes = [DecisionOutcome.APPROVE_PROPOSAL, DecisionOutcome.REJECT_PROPOSAL]
        findings.append(
            _finding(
                finding_id="DUP-EXACT",
                finding_type="EXACT_DUPLICATE",
                title_zh="完全重复记录可从发布中排除",
                title_en="Exact duplicate records can be excluded from release",
                explanation_zh=(
                    f"{_n(surplus_count)} 条记录与更早出现的记录在全部 {ctx.frame.width} "
                    f"列上完全一致"
                    f"（{_n(group_count)} 组重复），仅多余出现次数会被排除，首次出现保留。"
                ),
                explanation_en=(
                    f"{_n(surplus_count)} records are identical to an earlier record across all "
                    f"{ctx.frame.width} columns ({_n(group_count)} duplicate groups); only the "
                    f"surplus "
                    "occurrences are excluded, the first occurrence stays."
                ),
                column=None,
                record_uids=ctx.uids_for(surplus),
                risk=RiskLevel.LOW,
                blocking=False,
                authorization=authorization,
                action=action,
                allowed_outcomes=outcomes,
                signals=[
                    _signal(
                        "identical_payload",
                        "PASS",
                        "每条多余记录都与一条更早的完整记录逐列一致。",
                        "Each surplus occurrence matches an earlier complete record column by "
                        "column.",
                        "EVID-DUPLICATE-01",
                    )
                ],
                details={
                    "surplus_record_count": surplus_count,
                    "duplicate_group_count": group_count,
                    "compared_columns": ctx.frame.width,
                },
                cell_count=0,
            )
        )
    if ctx.observational or not ctx.contract.business_key:
        return findings
    keys = list(ctx.contract.business_key)
    missing = [key for key in keys if key not in ctx.frame.columns]
    if missing:
        ctx.warn(
            f"业务键列 {_join(missing)} 不存在于数据集，跳过业务键冲突检测。",
            f"Business-key column(s) {_join(missing)} are not in the dataset; DUP-KEY skipped.",
        )
        return findings
    key_non_empty = pl.Series([True] * ctx.frame.height, dtype=pl.Boolean)
    for key in keys:
        key_non_empty = key_non_empty & ~ctx.stats[key].empty_mask
    base = (
        ctx.frame.select(keys)
        .with_row_index("__ord")
        .filter(~surplus & key_non_empty)
        .group_by(keys)
        .agg(pl.len().alias("n"), pl.col("__ord"))
        .filter(pl.col("n") > 1)
    )
    if base.height == 0:
        return findings
    ctx.key_surplus = int((base.get_column("n") - 1).sum())
    ordinals = sorted(int(item) for group in base.get_column("__ord").to_list() for item in group)
    record_uids = [ctx.uids[ordinal] for ordinal in ordinals]
    findings.append(
        _finding(
            finding_id="DUP-KEY",
            finding_type="BUSINESS_KEY_CONFLICT",
            title_zh="业务键冲突记录需要隔离",
            title_en="Business-key conflicts require quarantine",
            explanation_zh=(
                f"{_n(base.height)} 组记录共享相同业务键（{_join(keys)}）但载荷不同，"
                f"涉及 {_n(len(record_uids))} 条记录；引擎不会猜测哪一条正确。"
            ),
            explanation_en=(
                f"{_n(base.height)} groups share the same business key ({_join(keys)}) with "
                f"different payloads, {_n(len(record_uids))} records in total; the engine never "
                "guesses which one is right."
            ),
            column=keys[0] if len(keys) == 1 else None,
            record_uids=record_uids,
            risk=RiskLevel.HIGH,
            blocking=True,
            authorization=AuthorizationMode.QUARANTINE_ONLY,
            action=AllowedAction.QUARANTINE_RECORDS,
            allowed_outcomes=[DecisionOutcome.QUARANTINE],
            signals=[
                _signal(
                    "business_key_uniqueness",
                    "FAIL",
                    "同一业务键对应多条内容不同的记录。",
                    "The same business key maps to more than one distinct record.",
                    "EVID-KEY-01",
                )
            ],
            details={
                "business_key": keys,
                "conflict_group_count": base.height,
                "key_surplus": ctx.key_surplus,
            },
        )
    )
    return findings


# --------------------------------------------------------------------------------------
# Category / semantic / ambiguity per column
# --------------------------------------------------------------------------------------


@dataclass
class CategoryOutcome:
    findings: list[Finding] = field(default_factory=list)
    conflict_finding: Finding | None = None
    ambiguity_finding: Finding | None = None
    sem_finding: Finding | None = None
    covered_values: set[str] = field(default_factory=set)  # values VAL must not count again


def semantic_candidate_values(
    stats: ColumnStats,
    contract: DataContract,
    column: str,
) -> tuple[list[tuple[str, int]], bool]:
    """Distinct values outside the vocabulary and the ambiguity registry, capped at 30."""
    vocabulary = sorted(contract.vocabulary(column))
    ambiguity = sorted(contract.ambiguity_tokens(column))
    values = stats.values
    mask = ~values.is_in(vocabulary) & ~values.is_in(ambiguity)
    mask = mask & (values.str.len_chars() <= SEM_CANDIDATE_MAX_CHARS)
    subset = stats.counts.filter(mask.fill_null(False))
    pairs: list[tuple[str, int]] = []
    for value, count in zip(
        subset.get_column("value").to_list(), subset.get_column("count").to_list(), strict=True
    ):
        text = str(value)
        if classify_value(text) is not None:
            continue
        pairs.append((text, int(count)))
    pairs.sort(key=lambda item: (-item[1], item[0]))
    truncated = len(pairs) > SEM_CANDIDATE_LIMIT
    return pairs[:SEM_CANDIDATE_LIMIT], truncated


def _proposal_summary(
    proposal: AIProposal, grounding: GroundingResult, ledger_call_id: str | None
) -> AIProposalSummary:
    return AIProposalSummary(
        provider=proposal.provider,  # type: ignore[arg-type]
        model=proposal.model,
        prompt_version=proposal.prompt_version,
        input_hash=proposal.input_hash,
        mapping=dict(proposal.mapping) if proposal.mapping else None,
        abstained=proposal.abstained,
        abstain_reason=proposal.abstain_reason,
        grounding=grounding,
        ledger_call_id=ledger_call_id,
    )


def _is_deterministic(provider: str) -> bool:
    return provider in (ProviderName.DETERMINISTIC.value, ProviderName.VERIFIED_REPLAY.value)


@dataclass
class SemanticResolution:
    summary: AIProposalSummary
    mapping: dict[str, str]
    resolver: str  # "ai" | "deterministic"
    ai_attempt: dict[str, Any] | None


def resolve_semantic(
    ctx: DetectionContext,
    request: SemanticRequest,
    alias_map: Mapping[str, str],
    vocabulary: set[str],
) -> SemanticResolution:
    candidates = set(request.candidate_counts)

    def usable(mapping: Mapping[str, str] | None) -> dict[str, str]:
        if not mapping:
            return {}
        return {
            source: target
            for source, target in mapping.items()
            if source in candidates
            and target in vocabulary
            and source != target
            and source not in request.ambiguity_tokens
        }

    ai_attempt: dict[str, Any] | None = None
    resolved: tuple[AIProposal, GroundingResult, str | None] | None = None
    if ctx.resolver is not None:
        started = time.perf_counter()
        try:
            resolved = ctx.resolver.resolve(request, run_id=ctx.run_id or "")
        except Exception as error:  # noqa: BLE001 - any resolver failure degrades safely
            ai_attempt = {
                "provider": None,
                "model": None,
                "status": "error",
                "error_type": type(error).__name__,
                "reason_codes": [],
                "ledger_call_id": None,
            }
            ctx.warn(
                f"列 `{request.column}` 的语义评估调用失败（{type(error).__name__}），"
                f"已降级为确定性回退。",
                f"Semantic assessment for `{request.column}` failed ({type(error).__name__}); "
                "degraded to the deterministic fallback.",
            )
        finally:
            ctx.semantic_ms += int((time.perf_counter() - started) * 1000)
    if resolved is not None:
        proposal, grounding, call_id = resolved
        mapping = usable(proposal.mapping) if grounding.valid and not proposal.abstained else {}
        if mapping:
            return SemanticResolution(
                summary=_proposal_summary(proposal, grounding, call_id),
                mapping=mapping,
                resolver="deterministic" if _is_deterministic(proposal.provider) else "ai",
                ai_attempt=None,
            )
        if not _is_deterministic(proposal.provider):
            status = (
                "rejected_by_grounding"
                if not grounding.valid
                else "abstained"
                if proposal.abstained
                else "no_mapping"
            )
            ai_attempt = {
                "provider": proposal.provider,
                "model": proposal.model,
                "status": status,
                "reason_codes": list(grounding.reason_codes),
                "abstain_reason": proposal.abstain_reason,
                "ledger_call_id": call_id,
            }
        fallback = deterministic_proposal(request, alias_map)
        fallback_mapping = usable(fallback.mapping)
        if fallback_mapping:
            return SemanticResolution(
                summary=_proposal_summary(
                    fallback,
                    GroundingResult(
                        valid=True,
                        reason_codes=[],
                        affected_record_count=sum(
                            request.candidate_counts[source] for source in fallback_mapping
                        ),
                    ),
                    call_id if _is_deterministic(proposal.provider) else None,
                ),
                mapping=fallback_mapping,
                resolver="deterministic",
                ai_attempt=ai_attempt,
            )
        # Nothing maps: keep the resolver's own (abstained / rejected) proposal visible.
        return SemanticResolution(
            summary=_proposal_summary(proposal, grounding, call_id),
            mapping={},
            resolver="deterministic" if _is_deterministic(proposal.provider) else "ai",
            ai_attempt=ai_attempt,
        )
    fallback = deterministic_proposal(request, alias_map)
    fallback_mapping = usable(fallback.mapping)
    return SemanticResolution(
        summary=_proposal_summary(
            fallback,
            GroundingResult(
                valid=True,
                reason_codes=[],
                affected_record_count=sum(
                    request.candidate_counts[source] for source in fallback_mapping
                ),
            ),
            None,
        ),
        mapping=fallback_mapping,
        resolver="deterministic",
        ai_attempt=ai_attempt,
    )


def _conflict_mask(
    ctx: DetectionContext,
    column: str,
    rule: FieldRule,
    mapping: Mapping[str, str],
) -> pl.Series | None:
    consistent = rule.consistent_with
    if consistent is None or not mapping:
        return None
    if consistent.column not in ctx.frame.columns:
        ctx.warn(
            f"字段 `{column}` 的 consistent_with 列 `{consistent.column}` 不存在，跳过一致性检查。",
            f"consistent_with column `{consistent.column}` for `{column}` is missing; "
            "consistency check skipped.",
        )
        return None
    other = ctx.frame.get_column(consistent.column)
    mask = pl.Series([False] * ctx.frame.height, dtype=pl.Boolean)
    for target, expected in consistent.expected.items():
        sources = [source for source, mapped in mapping.items() if mapped == target]
        if not sources:
            continue
        mask = mask | (ctx.rows_with(column, sources) & ~other.is_in(expected).fill_null(False))
    return mask


def detect_categories(ctx: DetectionContext, column: str, rule: FieldRule) -> CategoryOutcome:
    outcome = CategoryOutcome()
    stats = ctx.stats[column]
    contract = ctx.contract
    ambiguity = sorted(contract.ambiguity_tokens(column))
    alias_map = rule.alias_map()
    vocabulary = rule.vocabulary()
    targets = sorted(set(rule.canonical) | set(rule.allowed or []))

    # -- AMB ---------------------------------------------------------------------------
    if ambiguity:
        observed_ambiguous = stats.values_where(stats.values.is_in(ambiguity))
        if observed_ambiguous:
            rows = ctx.rows_with(column, observed_ambiguous)
            outcome.covered_values.update(observed_ambiguous)
            outcome.ambiguity_finding = _finding(
                finding_id=f"AMB-{column}",
                finding_type="KNOWN_AMBIGUOUS_TOKEN",
                title_zh=f"列 `{column}` 出现已知歧义词",
                title_en=f"Known ambiguous tokens in `{column}`",
                explanation_zh=(
                    f"{_n(int(rows.sum()))} 条记录的 `{column}` 取值属于歧义登记表"
                    f"（{_join(sorted(observed_ambiguous))}），契约禁止自动映射，只能隔离。"
                ),
                explanation_en=(
                    f"{_n(int(rows.sum()))} records have a `{column}` value listed in the "
                    f"ambiguity "
                    f"registry ({_join(sorted(observed_ambiguous))}); the contract forbids "
                    f"automatic "
                    "mapping, so they can only be quarantined."
                ),
                column=column,
                record_uids=ctx.uids_for(rows),
                risk=RiskLevel.HIGH,
                blocking=True,
                authorization=AuthorizationMode.QUARANTINE_ONLY,
                action=AllowedAction.QUARANTINE_RECORDS,
                allowed_outcomes=[DecisionOutcome.QUARANTINE],
                signals=[
                    _signal(
                        "ambiguity_registry",
                        "FAIL",
                        "命中的词在歧义登记表中，无法对应唯一含义。",
                        "The tokens are in the ambiguity registry and cannot map to one meaning.",
                        "EVID-AMBIGUITY-01",
                    )
                ],
                details={
                    "tokens": sorted(observed_ambiguous),
                    "registry": ambiguity,
                    "observed_counts": {
                        token: stats.value_count(token) for token in sorted(observed_ambiguous)
                    },
                    "ai_abstained": True,
                },
            )

    # -- CAT (exact alias hits) --------------------------------------------------------
    observed_aliases = stats.values_where(
        stats.values.is_in(sorted(alias_map)) & ~stats.values.is_in(ambiguity)
    )
    cat_mapping = {alias: alias_map[alias] for alias in sorted(observed_aliases)}

    # -- SEM (unlisted variants) -------------------------------------------------------
    sem_mapping: dict[str, str] = {}
    resolution: SemanticResolution | None = None
    request: SemanticRequest | None = None
    candidates: list[tuple[str, int]] = []
    truncated = False
    if rule.semantic and column not in ctx.withheld:
        candidates, truncated = semantic_candidate_values(stats, contract, column)
        if truncated:
            ctx.warn(
                f"列 `{column}` 的语义候选值超过 {SEM_CANDIDATE_LIMIT} 个，仅评估最常见的前 "
                f"{SEM_CANDIDATE_LIMIT} 个。",
                f"`{column}` has more than {SEM_CANDIDATE_LIMIT} semantic candidates; only the "
                f"{SEM_CANDIDATE_LIMIT} most frequent were assessed.",
            )
        if candidates:
            refs = [EVID_VOCAB, EVID_COUNTS]
            if ambiguity:
                refs.append(EVID_AMBIGUITY)
            if rule.consistent_with is not None:
                refs.append(EVID_CONSISTENCY)
            request = SemanticRequest(
                finding_id=f"SEM-{column}",
                column=column,
                candidate_counts={value: count for value, count in candidates},
                canonical_vocabulary=targets,
                evidence_refs=refs,
                ambiguity_tokens=ambiguity,
            )
            resolution = resolve_semantic(ctx, request, alias_map, vocabulary)
            sem_mapping = resolution.mapping
    elif rule.semantic and column in ctx.withheld:
        ctx.warn(
            f"列 `{column}` 含敏感模式命中，已跳过语义评估（不会发送给 AI）。",
            f"`{column}` carries sensitive pattern hits; semantic assessment skipped (nothing is "
            f"sent to AI).",
        )

    # -- consistency conflicts across the whole normalization scope --------------------
    full_mapping: dict[str, str] = {**cat_mapping, **sem_mapping}
    conflict = _conflict_mask(ctx, column, rule, full_mapping)
    conflict_uids: list[str] = ctx.uids_for(conflict) if conflict is not None else []
    no_conflict = ~conflict if conflict is not None else None

    def scoped(values: list[str]) -> pl.Series:
        rows = ctx.rows_with(column, values)
        return rows & no_conflict if no_conflict is not None else rows

    # -- CAT finding -------------------------------------------------------------------
    if cat_mapping:
        rows = scoped(list(cat_mapping))
        outcome.covered_values.update(cat_mapping)
        if contract.auto_authorization.category_normalization:
            authorization = AuthorizationMode.POLICY_AUTHORIZED
        else:
            authorization = AuthorizationMode.HUMAN_APPROVAL_REQUIRED
        target_count = len(set(cat_mapping.values()))
        outcome.findings.append(
            _finding(
                finding_id=f"CAT-{column}",
                finding_type="CATEGORY_VARIANT",
                title_zh=f"列 `{column}` 的别名可按契约词表归一",
                title_en=f"Aliases in `{column}` can be normalized per the contract glossary",
                explanation_zh=(
                    f"{_n(int(rows.sum()))} 条记录的 `{column}` 取值与契约词表中的 "
                    f"{len(cat_mapping)} 个"
                    f"精确别名匹配，可映射到 {target_count} 个规范值"
                    + (
                        f"；{_n(len(conflict_uids))} 条存在交叉字段冲突的记录已单独列出。"
                        if conflict_uids
                        else "。"
                    )
                ),
                explanation_en=(
                    f"{_n(int(rows.sum()))} records carry one of {len(cat_mapping)} exact glossary "
                    f"aliases in `{column}` that map to {target_count} canonical term"
                    f"{'s' if target_count != 1 else ''}"
                    + (
                        f"; {_n(len(conflict_uids))} records with a cross-field conflict are "
                        f"listed separately."
                        if conflict_uids
                        else "."
                    )
                ),
                column=column,
                record_uids=ctx.uids_for(rows),
                risk=RiskLevel.LOW,
                blocking=False,
                authorization=authorization,
                action=AllowedAction.NORMALIZE_CATEGORY,
                allowed_outcomes=[
                    DecisionOutcome.APPROVE_PROPOSAL,
                    DecisionOutcome.REJECT_PROPOSAL,
                ],
                signals=[
                    _signal(
                        "canonical_glossary_match",
                        "PASS",
                        "每个别名都精确出现在契约的 canonical 词表中。",
                        "Every alias appears verbatim in the contract's canonical glossary.",
                        "EVID-GLOSSARY-01",
                    ),
                    _signal(
                        "code_cooccurrence_consistency",
                        "PASS" if rule.consistent_with is not None else "NOT_APPLICABLE",
                        "范围内记录的关联字段均在契约期望值内。"
                        if rule.consistent_with is not None
                        else "该字段未声明 consistent_with 规则。",
                        "Every record in scope satisfies the consistent_with expectation."
                        if rule.consistent_with is not None
                        else "No consistent_with rule is declared for this field.",
                        "EVID-CODE-02",
                    ),
                ],
                details={
                    "mapping": cat_mapping,
                    "observed_counts": {alias: stats.value_count(alias) for alias in cat_mapping},
                    "conflict_record_count": len(conflict_uids),
                },
            )
        )

    # -- SEM finding -------------------------------------------------------------------
    if request is not None and resolution is not None:
        candidate_counts = dict(request.candidate_counts)
        unmapped = [value for value, _ in candidates if value not in sem_mapping]
        base_details: dict[str, Any] = {
            "candidate_counts": candidate_counts,
            "candidate_record_count": sum(candidate_counts.values()),
            "candidates_truncated": truncated,
            "mapping": sem_mapping or None,
            "mapped_record_count": sum(candidate_counts[value] for value in sem_mapping),
            "unmapped_values": unmapped,
            "unmapped_record_count": sum(candidate_counts[value] for value in unmapped),
            "resolver": resolution.resolver,
            "ai_attempt": resolution.ai_attempt,
            "conflict_record_count": len(conflict_uids),
            "request": request.model_dump(mode="json"),
        }
        provider_zh = "AI" if resolution.resolver == "ai" else "确定性回退"
        provider_en = "the AI" if resolution.resolver == "ai" else "the deterministic fallback"
        if sem_mapping:
            rows = scoped(list(sem_mapping))
            outcome.covered_values.update(sem_mapping)
            all_string_match = all(
                normalize_text(source) == normalize_text(target)
                or any(
                    normalize_text(source) == normalize_text(alias)
                    for alias, mapped in alias_map.items()
                    if mapped == target
                )
                for source, target in sem_mapping.items()
            )
            outcome.sem_finding = _finding(
                finding_id=f"SEM-{column}",
                finding_type="SEMANTIC_VARIANT",
                title_zh=f"列 `{column}` 的未登记变体可按提议归一",
                title_en=f"Unlisted variants in `{column}` can be normalized per the proposal",
                explanation_zh=(
                    f"{len(sem_mapping)} 个词表未登记的取值（{_n(int(rows.sum()))} 条记录）"
                    f"由{provider_zh}"
                    f"提议映射到规范词表，映射已通过接地校验；{len(unmapped)} 个取值未映射。"
                ),
                explanation_en=(
                    f"{len(sem_mapping)} values absent from the glossary ({_n(int(rows.sum()))} "
                    f"records) "
                    f"were mapped to the canonical vocabulary by {provider_en}; the mapping passed "
                    f"grounding; {len(unmapped)} value{'s' if len(unmapped) != 1 else ''} stay "
                    f"unmapped."
                ),
                column=column,
                record_uids=ctx.uids_for(rows),
                risk=RiskLevel.MEDIUM,
                blocking=True,
                authorization=AuthorizationMode.HUMAN_APPROVAL_REQUIRED,
                action=AllowedAction.NORMALIZE_CATEGORY,
                allowed_outcomes=[
                    DecisionOutcome.APPROVE_PROPOSAL,
                    DecisionOutcome.QUARANTINE,
                    DecisionOutcome.REJECT_PROPOSAL,
                ],
                signals=[
                    _signal(
                        "canonical_glossary_match",
                        "PASS",
                        "提议的每个目标值都在契约词表内（接地校验通过）。",
                        "Every proposed target is in the contract vocabulary (grounding passed).",
                        "EVID-GLOSSARY-01",
                    ),
                    _signal(
                        "normalized_string_match",
                        "PASS" if all_string_match else "NOT_APPLICABLE",
                        "所有映射在归一化后字符串一致。"
                        if all_string_match
                        else "部分映射是语义等价而非字符串一致，需人工确认。",
                        "Every mapping is a normalized string match."
                        if all_string_match
                        else "Some mappings are semantic rather than string-identical; human "
                        "review required.",
                        "EVID-STRING-01",
                    ),
                    _signal(
                        "code_cooccurrence_consistency",
                        "PASS" if rule.consistent_with is not None else "NOT_APPLICABLE",
                        f"提议范围内记录的关联字段均符合契约期望；{_n(len(conflict_uids))} "
                        f"条冲突记录已拆分。"
                        if rule.consistent_with is not None
                        else "该字段未声明 consistent_with 规则。",
                        f"All records in scope satisfy consistent_with; {_n(len(conflict_uids))} "
                        "conflicting records were split out."
                        if rule.consistent_with is not None
                        else "No consistent_with rule is declared for this field.",
                        "EVID-CODE-02",
                    ),
                    _signal(
                        "grounding_validation",
                        "PASS",
                        "映射来源 ⊆ 观测候选值，目标 ⊆ 词表，证据引用 ⊆ 提供的引用。",
                        "Sources ⊆ observed candidates, targets ⊆ vocabulary, evidence refs ⊆ "
                        "supplied refs.",
                        "EVID-GROUNDING-01",
                    ),
                ],
                details=base_details,
                proposal=resolution.summary,
            )
        elif rule.allowed is not None:
            rows = scoped([value for value, _ in candidates])
            outcome.covered_values.update(value for value, _ in candidates)
            reason_zh = {
                "ai": "AI 弃权或提议未通过接地校验",
                "deterministic": "无 AI，且归一化字符串匹配未命中",
            }[resolution.resolver]
            reason_en = {
                "ai": "the AI abstained or its proposal failed grounding",
                "deterministic": "no AI was available and no normalized string match exists",
            }[resolution.resolver]
            outcome.sem_finding = _finding(
                finding_id=f"SEM-{column}",
                finding_type="SEMANTIC_VARIANT",
                title_zh=f"列 `{column}` 的未登记取值没有可执行的映射提议",
                title_en=f"Unlisted values in `{column}` have no approvable mapping proposal",
                explanation_zh=(
                    f"{len(candidates)} 个词表未登记的取值（{_n(int(rows.sum()))} 条记录）"
                    f"未获得可执行映射"
                    f"（{reason_zh}）；该字段为封闭词表，只能隔离或拒绝。"
                ),
                explanation_en=(
                    f"{len(candidates)} values absent from the glossary ({_n(int(rows.sum()))} "
                    f"records) "
                    f"have no approvable mapping ({reason_en}); the field is a closed vocabulary, "
                    f"so "
                    "they can only be quarantined or the proposal rejected."
                ),
                column=column,
                record_uids=ctx.uids_for(rows),
                risk=RiskLevel.MEDIUM,
                blocking=True,
                authorization=AuthorizationMode.HUMAN_APPROVAL_REQUIRED,
                action=None,
                allowed_outcomes=[DecisionOutcome.QUARANTINE, DecisionOutcome.REJECT_PROPOSAL],
                signals=[
                    _signal(
                        "canonical_glossary_match",
                        "FAIL",
                        "候选取值不在契约词表内，且没有通过接地校验的映射。",
                        "Candidates are outside the contract vocabulary and no grounded mapping "
                        "exists.",
                        "EVID-GLOSSARY-01",
                    ),
                    _signal(
                        "grounding_validation",
                        "FAIL" if not resolution.summary.grounding.valid else "NOT_APPLICABLE",
                        "接地校验拒绝：" + _join(resolution.summary.grounding.reason_codes)
                        if not resolution.summary.grounding.valid
                        else "没有可校验的映射（弃权）。",
                        "Grounding rejected: " + _join(resolution.summary.grounding.reason_codes)
                        if not resolution.summary.grounding.valid
                        else "No mapping to validate (abstention).",
                        "EVID-GROUNDING-01",
                    ),
                ],
                details=base_details,
                proposal=resolution.summary,
            )
        else:
            ctx.warn(
                f"列 `{column}`：{len(candidates)} 个未登记取值未获得可执行映射，字段为开放词表，"
                f"保持原样。",
                f"`{column}`: {len(candidates)} unlisted values got no approvable mapping; the "
                f"field is an "
                "open vocabulary, so they stay as they are.",
            )

    # -- SEM-<col>-CONFLICT ------------------------------------------------------------
    if conflict_uids and rule.consistent_with is not None:
        other = rule.consistent_with.column
        parents = [f"CAT-{column}"] if cat_mapping else []
        if outcome.sem_finding is not None:
            parents.append(outcome.sem_finding.finding_id)
        outcome.conflict_finding = _finding(
            finding_id=f"SEM-{column}-CONFLICT",
            finding_type="SEMANTIC_CONFLICT",
            title_zh=f"列 `{column}` 的归一范围内存在交叉字段冲突",
            title_en=f"Cross-field conflicts inside the `{column}` normalization scope",
            explanation_zh=(
                f"{_n(len(conflict_uids))} 条记录的 `{column}` 可映射到规范值，但 `{other}` "
                f"不在契约期望的"
                f"取值内；这些记录不会被归一，只能隔离。"
            ),
            explanation_en=(
                f"{_n(len(conflict_uids))} records have a `{column}` value that maps to a "
                f"canonical term, "
                f"but `{other}` is outside the contract's expected values; they are not "
                f"normalized and can "
                "only be quarantined."
            ),
            column=column,
            record_uids=conflict_uids,
            risk=RiskLevel.HIGH,
            blocking=True,
            authorization=AuthorizationMode.QUARANTINE_ONLY,
            action=AllowedAction.QUARANTINE_RECORDS,
            allowed_outcomes=[DecisionOutcome.QUARANTINE],
            signals=[
                _signal(
                    "code_cooccurrence_consistency",
                    "FAIL",
                    f"记录的 `{other}` 不在映射目标所要求的期望值内。",
                    f"The record's `{other}` is not among the values the mapped target requires.",
                    "EVID-CODE-CONFLICT-04",
                )
            ],
            details={
                "parent_finding_ids": parents,
                "consistent_with": rule.consistent_with.model_dump(mode="json"),
            },
        )
    return outcome


# --------------------------------------------------------------------------------------
# MISS / FMT / VAL per column
# --------------------------------------------------------------------------------------


def detect_missing(ctx: DetectionContext, column: str) -> Finding | None:
    stats = ctx.stats[column]
    if stats.empty == 0:
        return None
    return _finding(
        finding_id=f"MISS-{column}",
        finding_type="REQUIRED_FIELD_MISSING",
        title_zh=f"必填字段 `{column}` 为空",
        title_en=f"Required field `{column}` is empty",
        explanation_zh=(
            f"{_n(stats.empty)} 条记录的必填字段 `{column}` 为空；引擎不做任何填补，只能隔离。"
        ),
        explanation_en=(
            f"{_n(stats.empty)} records have an empty required `{column}`; the engine never "
            f"imputes, "
            "so they can only be quarantined."
        ),
        column=column,
        record_uids=ctx.uids_for(stats.empty_mask),
        risk=RiskLevel.HIGH,
        blocking=True,
        authorization=AuthorizationMode.QUARANTINE_ONLY,
        action=AllowedAction.QUARANTINE_RECORDS,
        allowed_outcomes=[DecisionOutcome.QUARANTINE],
        signals=[
            _signal(
                "safe_imputation_evidence",
                "FAIL",
                "没有证据支持安全地推断缺失值。",
                "No evidence supports imputing the missing value safely.",
                "EVID-MISSING-01",
            )
        ],
        details={"automatic_imputation": "FORBIDDEN", "empty_cell_count": stats.empty},
    )


@dataclass
class DateSplit:
    valid_mask: pl.Series
    accepted: list[tuple[str, list[str]]]  # (format, distinct values)
    unparseable: list[str]


def split_date_values(stats: ColumnStats, rule: FieldRule) -> DateSplit:
    valid = type_mask(stats, rule)
    assigned = valid.clone()
    accepted: list[tuple[str, list[str]]] = []
    if rule.accept_formats:
        for fmt, mask in zip(
            rule.accept_formats,
            format_masks(stats, rule.accept_formats, datetime=rule.type == "datetime"),
            strict=True,
        ):
            take = mask & ~assigned
            values = stats.values_where(take)
            if values:
                accepted.append((fmt, values))
            assigned = assigned | take
    return DateSplit(
        valid_mask=valid,
        accepted=accepted,
        unparseable=stats.values_where(~assigned),
    )


def detect_format_contract(
    ctx: DetectionContext, column: str, rule: FieldRule, split: DateSplit
) -> Finding | None:
    if not split.accepted:
        return None
    target = rule.format or (
        DEFAULT_DATETIME_FORMAT if rule.type == "datetime" else DEFAULT_DATE_FORMAT
    )
    per_format: list[dict[str, Any]] = []
    all_uids: list[str] = []
    for fmt, values in split.accepted:
        uids = ctx.uids_for(ctx.rows_with(column, values))
        per_format.append({"format": fmt, "record_count": len(uids), "record_uids": uids})
        all_uids.extend(uids)
    formats = [fmt for fmt, _ in split.accepted]
    if ctx.contract.auto_authorization.date_standardization:
        authorization = AuthorizationMode.POLICY_AUTHORIZED
    else:
        authorization = AuthorizationMode.HUMAN_APPROVAL_REQUIRED
    return _finding(
        finding_id=f"FMT-{column}",
        finding_type="FORMAT_INCONSISTENCY",
        title_zh=f"日期字段 `{column}` 使用了契约允许的替代格式",
        title_en=f"Date field `{column}` uses an accepted alternate format",
        explanation_zh=(
            f"{_n(len(all_uids))} 条记录的 `{column}` 匹配契约 accept_formats 中的 "
            f"{_join(formats)}，"
            f"可无歧义地标准化为 {target}。"
        ),
        explanation_en=(
            f"{_n(len(all_uids))} records in `{column}` match the contract's accept_formats "
            f"({_join(formats)}) and can be standardized to {target} without ambiguity."
        ),
        column=column,
        record_uids=all_uids,
        risk=RiskLevel.LOW,
        blocking=False,
        authorization=authorization,
        action=AllowedAction.STANDARDIZE_DATE_FORMAT,
        allowed_outcomes=[DecisionOutcome.APPROVE_PROPOSAL, DecisionOutcome.REJECT_PROPOSAL],
        signals=[
            _signal(
                "unambiguous_date_parse",
                "PASS",
                "每个受影响的值都能按声明的替代格式唯一解析。",
                "Every affected value parses uniquely under the declared alternate format.",
                "EVID-DATE-PARSE-01",
            )
        ],
        details={
            "target_format": target,
            "source_format": formats[0],
            "source_formats": per_format,
        },
    )


def detect_format_observational(ctx: DetectionContext, column: str) -> Finding | None:
    stats = ctx.stats[column]
    if stats.inferred_type != "date" or stats.non_empty == 0:
        return None
    iso = stats.patterns.get(PATTERN_YMD_DASH, 0)
    if iso < OBSERVATIONAL_ISO_SHARE * stats.non_empty:
        return None
    alternates = [
        pattern for pattern in _OBSERVATIONAL_ALTERNATES if stats.patterns.get(pattern, 0) > 0
    ]
    if len(alternates) != 1:
        return None
    pattern = alternates[0]
    values = stats.values_where(stats.counts.get_column("pattern") == pattern)
    uids = ctx.uids_for(ctx.rows_with(column, values))
    source_format = PATTERN_FORMATS[pattern]
    return _finding(
        finding_id=f"FMT-{column}",
        finding_type="FORMAT_INCONSISTENCY",
        title_zh=f"日期字段 `{column}` 混用了第二种无歧义格式",
        title_en=f"Date field `{column}` mixes in a second unambiguous format",
        explanation_zh=(
            f"{_n(len(uids))} 条记录的 `{column}` 使用 {pattern}，其余 {_n(iso)} 条为 ISO 格式。"
            "观测模式：没有契约授权，不执行标准化。"
        ),
        explanation_en=(
            f"{_n(len(uids))} records in `{column}` use {pattern} while {_n(iso)} are ISO. "
            "Observational mode: no contract authorizes standardization, nothing is executed."
        ),
        column=column,
        record_uids=uids,
        risk=RiskLevel.LOW,
        blocking=False,
        authorization=AuthorizationMode.FORBIDDEN,
        action=None,
        allowed_outcomes=[],
        signals=[
            _signal(
                "unambiguous_date_parse",
                "PASS",
                "替代格式在整列范围内可唯一判定日/月顺序。",
                "The alternate pattern's day/month order is unambiguous across the column.",
                "EVID-DATE-PARSE-01",
            )
        ],
        details={
            "target_format": DEFAULT_DATE_FORMAT,
            "source_format": source_format,
            "source_formats": [
                {"format": source_format, "record_count": len(uids), "record_uids": uids}
            ],
            "observational": True,
        },
    )


def detect_validity(
    ctx: DetectionContext,
    column: str,
    rule: FieldRule,
    *,
    covered_values: set[str],
    date_split: DateSplit | None,
    sem_scope_values: set[str],
) -> Finding | None:
    stats = ctx.stats[column]
    kinds: dict[str, list[str]] = {}
    if rule.type is not None:
        if rule.is_date and date_split is not None:
            bad = date_split.unparseable
        else:
            bad = stats.values_where(~type_mask(stats, rule))
        if bad:
            kinds["type"] = bad
    for kind, mask in constraint_violations(stats, rule).items():
        bad = stats.values_where(mask)
        if bad:
            kinds[kind] = bad
    if rule.allowed is not None:
        vocabulary = sorted(rule.vocabulary())
        ambiguity = sorted(ctx.contract.ambiguity_tokens(column))
        misses = stats.values_where(
            ~stats.values.is_in(vocabulary) & ~stats.values.is_in(ambiguity)
        )
        misses = [
            value
            for value in misses
            if value not in covered_values and value not in sem_scope_values
        ]
        if misses:
            kinds["allowed"] = misses
    rows = pl.Series([False] * ctx.frame.height, dtype=pl.Boolean)
    summary: dict[str, dict[str, Any]] = {}
    for kind, values in kinds.items():
        kind_rows = ctx.rows_with(column, values)
        rows = rows | kind_rows
        entry: dict[str, Any] = {
            "record_count": int(kind_rows.sum()),
            "distinct_values": len(values),
        }
        if column not in ctx.withheld:
            entry["examples"] = [value for value in values[:10] if classify_value(value) is None]
        summary[kind] = entry
    if rule.unique and column not in ctx.contract.business_key:
        non_empty_first = ~stats.empty_mask & ~ctx.exact_surplus
        series = ctx.frame.get_column(column)
        repeated = (
            pl.DataFrame({"v": series, "keep": non_empty_first})
            .with_row_index("__ord")
            .filter(pl.col("keep"))
            .select(pl.col("__ord"), pl.col("v").is_duplicated().alias("d"))
            .filter(pl.col("d"))
            .get_column("__ord")
            .to_list()
        )
        if repeated:
            unique_rows = pl.Series([False] * ctx.frame.height, dtype=pl.Boolean)
            unique_rows = unique_rows.scatter([int(item) for item in repeated], True)
            rows = rows | unique_rows
            summary["unique"] = {"record_count": len(repeated), "distinct_values": None}
    if not summary:
        return None
    record_uids = ctx.uids_for(rows)
    kinds_text = _join(summary)
    return _finding(
        finding_id=f"VAL-{column}",
        finding_type="VALIDITY_VIOLATION",
        title_zh=f"字段 `{column}` 存在违反契约约束的取值",
        title_en=f"Values in `{column}` violate contract constraints",
        explanation_zh=(
            f"{_n(len(record_uids))} 条记录的 `{column}` 违反契约约束（{kinds_text}）；"
            "没有可执行的自动修正，需要人工隔离或标记复核。"
        ),
        explanation_en=(
            f"{_n(len(record_uids))} records violate the contract constraints on `{column}` "
            f"({kinds_text}); there is no automatic fix, so a human quarantines or flags them."
        ),
        column=column,
        record_uids=record_uids,
        risk=RiskLevel.MEDIUM,
        blocking=True,
        authorization=AuthorizationMode.HUMAN_APPROVAL_REQUIRED,
        action=AllowedAction.QUARANTINE_RECORDS,
        allowed_outcomes=[DecisionOutcome.QUARANTINE, DecisionOutcome.FLAG_FOR_REVIEW],
        signals=[
            _signal(
                "contract_constraint",
                "FAIL",
                f"违反的约束：{kinds_text}。",
                f"Violated constraints: {kinds_text}.",
                "EVID-VALIDITY-01",
            )
        ],
        details={
            "violations": summary,
            "constraints": rule.model_dump(
                mode="json",
                include={
                    "type",
                    "format",
                    "min",
                    "max",
                    "max_length",
                    "pattern",
                    "allowed",
                    "unique",
                },
                exclude_defaults=True,
            ),
        },
    )


# --------------------------------------------------------------------------------------
# Sensitive columns
# --------------------------------------------------------------------------------------


def detect_sensitive(ctx: DetectionContext) -> list[Finding]:
    findings: list[Finding] = []
    contract = ctx.contract
    declared = set(contract.sensitive_fields())
    for column in ctx.frame.columns:
        stats = ctx.stats[column]
        hits = stats.sensitive.hit_count
        classes = stats.sensitive.class_counts
        classes_text = _join(f"{name}×{count}" for name, count in classes.items())
        if not ctx.observational:
            if column not in declared:
                if hits:
                    ctx.warn(
                        f"列 `{column}` 未在契约中声明为敏感字段，但检测到 {_n(hits)} "
                        f"个敏感模式命中（{classes_text}）。",
                        f"`{column}` is not declared sensitive in the contract but has {_n(hits)} "
                        f"sensitive pattern hits ({classes_text}).",
                    )
                continue
            if not hits:
                if stats.non_empty:
                    ctx.warn(
                        f"契约将 `{column}` 声明为敏感字段但未检测到敏感模式命中；"
                        "该列已遮蔽并对 AI 隐藏，不生成发布排除发现。",
                        f"`{column}` is declared sensitive but no sensitive pattern matched; "
                        "the column is masked and withheld from AI, and no release-exclusion "
                        "finding is raised.",
                    )
                continue
            rows = ctx.rows_with(column, stats.sensitive.hit_values)
            findings.append(
                _finding(
                    finding_id=f"PHI-{column}",
                    finding_type="POTENTIAL_DIRECT_IDENTIFIER",
                    title_zh=f"敏感字段 `{column}` 需要在发布前处置",
                    title_en=f"Sensitive column `{column}` requires a release decision",
                    explanation_zh=(
                        f"`{column}` 被契约声明为敏感字段；检测到 {_n(hits)} 个单元格命中敏感模式"
                        + (f"（{classes_text}）" if classes else "")
                        + "。原始值已遮蔽，且不会发送给 AI；建议整列排除出发布。"
                    ),
                    explanation_en=(
                        f"`{column}` is declared sensitive by the contract; {_n(hits)} cells hit a "
                        "sensitive pattern"
                        + (f" ({classes_text})" if classes else "")
                        + ". Raw values are masked and never sent to AI; excluding the whole "
                        "column "
                        "from release is the expected decision."
                    ),
                    column=column,
                    record_uids=ctx.uids_for(rows),
                    risk=RiskLevel.HIGH,
                    blocking=True,
                    authorization=AuthorizationMode.HUMAN_APPROVAL_REQUIRED,
                    action=AllowedAction.EXCLUDE_COLUMN_FROM_RELEASE,
                    allowed_outcomes=[DecisionOutcome.EXCLUDE, DecisionOutcome.QUARANTINE],
                    signals=[
                        _signal(
                            "sensitive_pattern_preflight",
                            "FAIL" if hits else "PASS",
                            f"敏感模式预检命中 {_n(hits)} 个单元格；"
                            f"原始证据已遮蔽并对语义分析隐藏。",
                            f"Sensitive preflight hit {_n(hits)} cells; raw evidence is masked and "
                            "withheld from semantic analysis.",
                            "EVID-SENSITIVE-01",
                        ),
                        _signal(
                            "contract_sensitive_declaration",
                            "FAIL",
                            "契约将该字段声明为 sensitive。",
                            "The contract declares this field sensitive.",
                            "EVID-SENSITIVE-02",
                        ),
                    ],
                    details={
                        "declared_sensitive": True,
                        "pattern_classes": classes,
                        "hit_cell_count": hits,
                        "masked": True,
                        "not_sent_to_ai": True,
                    },
                )
            )
            continue
        # Observational mode: heuristic column names only, never actionable.
        if not hits:
            continue
        if not is_heuristic_sensitive_name(column):
            ctx.warn(
                f"列 `{column}` 检测到 {_n(hits)} 个敏感模式命中（{classes_text}），"
                f"但列名不符合敏感字段启发式。",
                f"`{column}` has {_n(hits)} sensitive pattern hits ({classes_text}) but its name "
                f"does "
                "not match the sensitive-column heuristic.",
            )
            continue
        rows = ctx.rows_with(column, stats.sensitive.hit_values)
        findings.append(
            _finding(
                finding_id=f"PHI-{column}",
                finding_type="POTENTIAL_DIRECT_IDENTIFIER",
                title_zh=f"列 `{column}` 可能含直接标识符",
                title_en=f"`{column}` may contain direct identifiers",
                explanation_zh=(
                    f"列名 `{column}` 符合敏感字段启发式，检测到 {_n(hits)} "
                    f"个单元格命中敏感模式（{classes_text}）。"
                    "观测模式：仅报告，原始值已遮蔽。"
                ),
                explanation_en=(
                    f"The column name `{column}` matches the sensitive heuristic and {_n(hits)} "
                    f"cells hit a "
                    f"sensitive pattern ({classes_text}). Observational mode: reported only, "
                    f"values masked."
                ),
                column=column,
                record_uids=ctx.uids_for(rows),
                risk=RiskLevel.HIGH,
                blocking=False,
                authorization=AuthorizationMode.FORBIDDEN,
                action=None,
                allowed_outcomes=[],
                signals=[
                    _signal(
                        "sensitive_pattern_preflight",
                        "FAIL",
                        f"敏感模式预检命中 {_n(hits)} 个单元格；原始证据已遮蔽。",
                        f"Sensitive preflight hit {_n(hits)} cells; raw evidence is masked.",
                        "EVID-SENSITIVE-01",
                    )
                ],
                details={
                    "declared_sensitive": False,
                    "pattern_classes": classes,
                    "hit_cell_count": hits,
                    "masked": True,
                    "not_sent_to_ai": True,
                    "observational": True,
                },
            )
        )
    return findings


# --------------------------------------------------------------------------------------
# Orchestration
# --------------------------------------------------------------------------------------


def run_detectors(ctx: DetectionContext) -> list[Finding]:
    """Run every detector; returns findings in a stable, grouped order."""
    duplicates = detect_duplicates(ctx)
    cat: list[Finding] = []
    fmt: list[Finding] = []
    sem: list[Finding] = []
    conflicts: list[Finding] = []
    amb: list[Finding] = []
    miss: list[Finding] = []
    val: list[Finding] = []
    contract = ctx.contract
    if contract.is_observational:
        for column in ctx.frame.columns:
            finding = detect_format_observational(ctx, column)
            if finding is not None:
                fmt.append(finding)
    else:
        for name in contract.fields:
            if name not in ctx.frame.columns:
                ctx.warn(
                    f"契约声明的字段 `{name}` 不存在于数据集，相关规则已跳过。",
                    f"Contract field `{name}` is not in the dataset; its rules were skipped.",
                )
        for column in ctx.frame.columns:
            rule = contract.rule(column)
            if rule is None:
                continue
            covered: set[str] = set()
            sem_scope: set[str] = set()
            if (
                rule.canonical
                or rule.allowed is not None
                or rule.semantic
                or contract.ambiguity_tokens(column)
            ):
                outcome = detect_categories(ctx, column, rule)
                cat.extend(outcome.findings)
                if outcome.sem_finding is not None:
                    sem.append(outcome.sem_finding)
                    mapping = outcome.sem_finding.details.get("mapping") or {}
                    sem_scope = set(mapping) if isinstance(mapping, dict) else set()
                if outcome.conflict_finding is not None:
                    conflicts.append(outcome.conflict_finding)
                if outcome.ambiguity_finding is not None:
                    amb.append(outcome.ambiguity_finding)
                covered = outcome.covered_values
            if rule.required:
                finding = detect_missing(ctx, column)
                if finding is not None:
                    miss.append(finding)
            date_split: DateSplit | None = None
            if rule.is_date:
                date_split = split_date_values(ctx.stats[column], rule)
                finding = detect_format_contract(ctx, column, rule, date_split)
                if finding is not None:
                    fmt.append(finding)
            finding = detect_validity(
                ctx,
                column,
                rule,
                covered_values=covered,
                date_split=date_split,
                sem_scope_values=sem_scope,
            )
            if finding is not None:
                val.append(finding)
    sensitive = detect_sensitive(ctx)
    return [*duplicates, *cat, *fmt, *sem, *conflicts, *amb, *miss, *val, *sensitive]
