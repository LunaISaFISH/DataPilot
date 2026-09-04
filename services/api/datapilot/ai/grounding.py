"""Deterministic grounding validators for the three AI tasks (spec §5.4).

Nothing the model returns is shown or executed before it passes one of these validators.
Each validator is pure: same inputs → same reason codes.
"""

from __future__ import annotations

import re
from copy import deepcopy
from decimal import Decimal, InvalidOperation
from typing import Any

from datapilot.ai.redaction import (
    build_semantic_payload,
    heuristic_sensitive_columns,
    observed_values,
    profile_evidence_refs,
    sanitize_value,
)
from datapilot.contracts.models import (
    AIProposal,
    ContractDraft,
    ContractDraftField,
    GroundingResult,
    RejectedRule,
    ReleaseBriefClaim,
    RunReport,
    SemanticRequest,
)
from datapilot.contracts.policy import (
    AutoAuthorization,
    DataContract,
    FieldRule,
    contract_to_yaml,
    parse_contract,
)

# --------------------------------------------------------------------------------------
# reason codes (with zh/en gloss for the permission card)
# --------------------------------------------------------------------------------------

SEMANTIC_REASON_CODES: dict[str, tuple[str, str]] = {
    "UNKNOWN_FINDING": (
        "提议的 finding_id 与请求不一致",
        "Proposal finding_id differs from the request",
    ),
    "UNKNOWN_COLUMN": ("提议的列不在请求范围内", "Proposal column is not the requested column"),
    "STALE_OR_UNKNOWN_INPUT": ("input_hash 与请求不匹配", "input_hash does not match the request"),
    "HALLUCINATED_SOURCE_VALUE": (
        "映射来源值从未被观测到",
        "A mapping source value was never observed",
    ),
    "UNKNOWN_CANONICAL_TARGET": (
        "映射目标不在规范词表内",
        "A mapping target is outside the vocabulary",
    ),
    "UNKNOWN_EVIDENCE_REFERENCE": ("引用了未提供的证据编号", "An evidence ref was not supplied"),
    "AMBIGUITY_REGISTRY_HIT": ("映射了歧义登记表中的值", "A registered ambiguous token was mapped"),
    "UNSUPPORTED_ACTION": ("提议了不允许的动作", "Proposed action is not allowed"),
    "ABSTENTION_WITH_MAPPING": ("声明弃权却仍给出映射", "Abstained but still returned a mapping"),
    "SCHEMA_VIOLATION": ("输出不符合结构化模式", "Output did not satisfy the output schema"),
}

DRAFT_REASON_CODES: dict[str, tuple[str, str]] = {
    "UNKNOWN_COLUMN": ("字段不在数据集列中", "Field is not a column of the dataset"),
    "UNOBSERVED_VALUE": (
        "取值未在提供的观测值中出现",
        "Value does not appear in the supplied observed values",
    ),
    "TYPE_MISMATCH": ("类型与推断类型不兼容", "Type is incompatible with the inferred type"),
    "SENSITIVE_DOWNGRADE": (
        "试图取消启发式敏感标记",
        "Attempted to remove a heuristic sensitive mark",
    ),
    "UNKNOWN_EVIDENCE": ("引用了未提供的证据编号", "Evidence ref was not supplied"),
    "UNKNOWN_FORMAT": ("格式与任何观测到的模式都不对应", "Format matches no observed pattern"),
}

BRIEF_REASON_CODES: dict[str, tuple[str, str]] = {
    "UNKNOWN_FACT": ("引用了不存在的事实编号", "Referenced fact_id does not exist"),
    "UNVERIFIED_NUMBER": ("数字与任何事实值都不相等", "A number equals no supplied fact value"),
}

GROUNDING_REASON_CODES: dict[str, dict[str, tuple[str, str]]] = {
    "semantic": SEMANTIC_REASON_CODES,
    "contract_draft": DRAFT_REASON_CODES,
    "brief": BRIEF_REASON_CODES,
}


# --------------------------------------------------------------------------------------
# 1. semantic mapping
# --------------------------------------------------------------------------------------


def request_hash(request: SemanticRequest) -> str:
    """The input hash of the exact redacted payload that is sent for ``request``."""
    return build_semantic_payload(request)[2]


def validate_proposal(request: SemanticRequest, proposal: AIProposal) -> GroundingResult:
    reasons: list[str] = []
    if proposal.finding_id != request.finding_id:
        reasons.append("UNKNOWN_FINDING")
    if proposal.column != request.column:
        reasons.append("UNKNOWN_COLUMN")
    if proposal.input_hash != request_hash(request):
        reasons.append("STALE_OR_UNKNOWN_INPUT")
    mapping = proposal.mapping or {}
    if set(mapping) - set(request.candidate_counts):
        reasons.append("HALLUCINATED_SOURCE_VALUE")
    if set(mapping.values()) - set(request.canonical_vocabulary):
        reasons.append("UNKNOWN_CANONICAL_TARGET")
    if set(proposal.evidence_refs) - set(request.evidence_refs):
        reasons.append("UNKNOWN_EVIDENCE_REFERENCE")
    if set(mapping) & set(request.ambiguity_tokens):
        reasons.append("AMBIGUITY_REGISTRY_HIT")
    if proposal.proposed_action not in {None, "NORMALIZE_CATEGORY"}:
        reasons.append("UNSUPPORTED_ACTION")
    if proposal.abstained and mapping:
        reasons.append("ABSTENTION_WITH_MAPPING")
    affected = (
        0
        if reasons or proposal.abstained
        else sum(request.candidate_counts[source] for source in mapping)
    )
    return GroundingResult(valid=not reasons, reason_codes=reasons, affected_record_count=affected)


REDTEAM_OFFLINE_CASES: tuple[str, ...] = (
    "HALLUCINATED_SOURCE_VALUE",
    "UNKNOWN_CANONICAL_TARGET",
    "UNKNOWN_EVIDENCE_REFERENCE",
    "UNSUPPORTED_ACTION",
    "STALE_OR_UNKNOWN_INPUT",
    "ABSTENTION_WITH_MAPPING",
    "AMBIGUITY_REGISTRY_HIT",
)


def tamper_proposal(
    case: str, request: SemanticRequest, proposal: AIProposal
) -> dict[str, Any]:
    """Apply one red-team mutation (spec §5.6) and return the raw tampered proposal dict.

    The result is a plain dict because ``UNSUPPORTED_ACTION`` must be rejected by the strict
    schema itself (``AIProposal.model_validate`` raises) rather than by ``validate_proposal``.
    """
    raw: dict[str, Any] = deepcopy(proposal.model_dump(mode="json"))
    mapping: dict[str, str] = dict(raw.get("mapping") or {})
    first_target = request.canonical_vocabulary[0] if request.canonical_vocabulary else "TARGET"
    if case == "HALLUCINATED_SOURCE_VALUE":
        mapping["__never_observed__"] = first_target
        raw["mapping"] = mapping
        raw["abstained"] = False
        raw["proposed_action"] = "NORMALIZE_CATEGORY"
    elif case == "UNKNOWN_CANONICAL_TARGET":
        source = next(iter(mapping), next(iter(request.candidate_counts), "value"))
        mapping[source] = "__outside_vocabulary__"
        raw["mapping"] = mapping
        raw["abstained"] = False
        raw["proposed_action"] = "NORMALIZE_CATEGORY"
    elif case == "UNKNOWN_EVIDENCE_REFERENCE":
        raw["evidence_refs"] = [*raw.get("evidence_refs", []), "EVID-FAKE-99"]
    elif case == "UNSUPPORTED_ACTION":
        raw["proposed_action"] = "DELETE_ROWS"
    elif case == "STALE_OR_UNKNOWN_INPUT":
        digest = str(raw.get("input_hash", ""))
        flipped = ("0" if digest[:1] != "0" else "1") + digest[1:]
        raw["input_hash"] = flipped
    elif case == "ABSTENTION_WITH_MAPPING":
        if not mapping:
            source = next(iter(request.candidate_counts), "value")
            mapping[source] = first_target
        raw["mapping"] = mapping
        raw["abstained"] = True
        raw["abstain_reason"] = raw.get("abstain_reason") or "tampered abstention"
    elif case == "AMBIGUITY_REGISTRY_HIT":
        token = request.ambiguity_tokens[0] if request.ambiguity_tokens else "__ambiguous__"
        mapping[token] = first_target
        raw["mapping"] = mapping
        raw["abstained"] = False
        raw["proposed_action"] = "NORMALIZE_CATEGORY"
    else:
        raise ValueError(f"unknown red-team case: {case}")
    return raw


# --------------------------------------------------------------------------------------
# 2. contract draft
# --------------------------------------------------------------------------------------

_TYPE_COMPATIBILITY: dict[str, set[str]] = {
    "integer": {"integer", "number", "string"},
    "number": {"number", "string"},
    "date": {"date", "string"},
    "datetime": {"datetime", "string"},
    "boolean": {"boolean", "string"},
    "string": {"string"},
    "empty": {"string"},
}

_PATTERN_TOKENS: tuple[tuple[str, str], ...] = (
    ("YYYY", "%Y"),
    ("DD", "%d"),
    ("HH", "%H"),
    ("SS", "%S"),
)


def pattern_to_strptime(pattern: str) -> str | None:
    """Translate an engine format pattern (``YYYY-MM-DD``, ``DD/MM/YYYY HH:MM:SS``) to strptime.

    ``MM`` means month before any hour token and minute after it. Patterns without a year
    (``digits``, ``mixed``) are not date formats and yield ``None``.
    """
    if "YYYY" not in pattern:
        return None
    out: list[str] = []
    index = 0
    seen_hour = False
    while index < len(pattern):
        for token, replacement in _PATTERN_TOKENS:
            if pattern.startswith(token, index):
                out.append(replacement)
                index += len(token)
                if token == "HH":
                    seen_hour = True
                break
        else:
            if pattern.startswith("MM", index):
                out.append("%M" if seen_hour else "%m")
                index += 2
            else:
                out.append(pattern[index])
                index += 1
    return "".join(out)


def observed_formats(report: RunReport, column: str) -> list[str]:
    """strptime formats derivable from a column's observed patterns, most frequent first."""
    formats: list[str] = []
    for profile in report.column_profiles:
        if profile.name != column:
            continue
        for item in sorted(profile.format_patterns, key=lambda fp: (-fp.count, fp.pattern)):
            translated = pattern_to_strptime(item.pattern)
            if translated is not None and translated not in formats:
                formats.append(translated)
    return formats


def _rejected(
    field: str, rule: str, code: str, detail_zh: str, detail_en: str
) -> RejectedRule:
    return RejectedRule(
        field=field, rule=rule, reason_code=code, detail_zh=detail_zh, detail_en=detail_en
    )


def _accepted(
    field: str,
    rule: str,
    value: Any,
    rule_zh: str,
    rule_en: str,
    draft_field: ContractDraftField | None,
    evidence_refs: list[str],
) -> dict[str, Any]:
    return {
        "field": field,
        "rule": rule,
        "value": value,
        "rule_zh": rule_zh,
        "rule_en": rule_en,
        "rationale_zh": draft_field.rationale_zh if draft_field is not None else "",
        "evidence_refs": evidence_refs,
    }


def _validate_field(
    draft_field: ContractDraftField,
    report: RunReport,
    observed: dict[str, set[str]],
    sensitive_columns: set[str],
    accepted: list[dict[str, Any]],
    rejected: list[RejectedRule],
) -> FieldRule | None:
    name = draft_field.name
    profile = next((p for p in report.column_profiles if p.name == name), None)
    if profile is None:
        rejected.append(
            _rejected(
                name,
                "field",
                "UNKNOWN_COLUMN",
                f"数据集中没有名为 `{sanitize_value(name)}` 的列。",
                f"The dataset has no column named `{sanitize_value(name)}`.",
            )
        )
        return None

    supplied_refs = set(profile_evidence_refs(name))
    unknown_refs = [ref for ref in draft_field.evidence_refs if ref not in supplied_refs]
    refs = [ref for ref in draft_field.evidence_refs if ref in supplied_refs]
    if unknown_refs:
        rejected.append(
            _rejected(
                name,
                "evidence_refs",
                "UNKNOWN_EVIDENCE",
                f"证据编号未提供：{sanitize_value(', '.join(unknown_refs))}",
                f"Evidence refs were not supplied: {sanitize_value(', '.join(unknown_refs))}",
            )
        )

    rule = FieldRule()
    observed_here = observed.get(name, set())

    if draft_field.required:
        rule = rule.model_copy(update={"required": True})
        accepted.append(
            _accepted(name, "required", True, "必填", "required", draft_field, refs)
        )
    if draft_field.unique:
        rule = rule.model_copy(update={"unique": True})
        accepted.append(_accepted(name, "unique", True, "唯一", "unique", draft_field, refs))

    # sensitive: may only add to the heuristic set, never remove
    if name in sensitive_columns:
        rule = rule.model_copy(update={"sensitive": True})
        if draft_field.sensitive:
            accepted.append(
                _accepted(name, "sensitive", True, "敏感字段", "sensitive", draft_field, refs)
            )
        else:
            rejected.append(
                _rejected(
                    name,
                    "sensitive",
                    "SENSITIVE_DOWNGRADE",
                    "该列已被启发式规则判定为敏感，草稿不能取消该标记；已保留 sensitive: true。",
                    "The column is heuristically sensitive; the draft may not remove the mark "
                    "(sensitive: true kept).",
                )
            )
    elif draft_field.sensitive:
        rule = rule.model_copy(update={"sensitive": True})
        accepted.append(
            _accepted(name, "sensitive", True, "敏感字段", "sensitive", draft_field, refs)
        )

    # type / format
    if draft_field.type is not None:
        compatible = _TYPE_COMPATIBILITY[profile.inferred_type]
        if draft_field.type in compatible:
            rule = rule.model_copy(update={"type": draft_field.type})
            accepted.append(
                _accepted(
                    name, "type", draft_field.type, "类型", "type", draft_field, refs
                )
            )
        else:
            rejected.append(
                _rejected(
                    name,
                    "type",
                    "TYPE_MISMATCH",
                    f"声明类型 {draft_field.type} 与推断类型 {profile.inferred_type} 不兼容。",
                    f"Declared type {draft_field.type} is incompatible with inferred type "
                    f"{profile.inferred_type}.",
                )
            )
    if draft_field.format is not None:
        formats = observed_formats(report, name)
        if draft_field.format in formats and rule.type in ("date", "datetime"):
            others = [fmt for fmt in formats if fmt != draft_field.format]
            rule = rule.model_copy(
                update={"format": draft_field.format, "accept_formats": others}
            )
            accepted.append(
                _accepted(
                    name, "format", draft_field.format, "日期格式", "format", draft_field, refs
                )
            )
            if others:
                accepted.append(
                    _accepted(
                        name,
                        "accept_formats",
                        others,
                        "可接受的替代格式（由观测模式推导）",
                        "accepted alternate formats (derived from observed patterns)",
                        None,
                        refs,
                    )
                )
        elif draft_field.format in formats:
            rejected.append(
                _rejected(
                    name,
                    "format",
                    "TYPE_MISMATCH",
                    "声明了日期格式但类型不是 date/datetime。",
                    "A date format was declared but the type is not date/datetime.",
                )
            )
        else:
            rejected.append(
                _rejected(
                    name,
                    "format",
                    "UNKNOWN_FORMAT",
                    f"格式 `{sanitize_value(draft_field.format)}` 与该列观测到的模式不对应。",
                    f"Format `{sanitize_value(draft_field.format)}` matches no observed pattern "
                    "of this column.",
                )
            )

    # allowed: every value must have been shown to the model
    if draft_field.allowed:
        unobserved = [value for value in draft_field.allowed if value not in observed_here]
        if unobserved:
            rejected.append(
                _rejected(
                    name,
                    "allowed",
                    "UNOBSERVED_VALUE",
                    f"允许值未在观测值中出现：{sanitize_value(', '.join(unobserved))}",
                    f"Allowed values were not observed: {sanitize_value(', '.join(unobserved))}",
                )
            )
        else:
            rule = rule.model_copy(update={"allowed": list(dict.fromkeys(draft_field.allowed))})
            accepted.append(
                _accepted(
                    name, "allowed", rule.allowed, "封闭取值集", "allowed values", draft_field, refs
                )
            )

    # canonical: target and aliases must be observed; aliases must not collide
    canonical: dict[str, list[str]] = {}
    seen_aliases: set[str] = set()
    for entry in draft_field.canonical:
        values = [entry.target, *entry.aliases]
        unobserved = [value for value in values if value not in observed_here]
        rule_name = f"canonical:{sanitize_value(entry.target)}"
        if unobserved:
            rejected.append(
                _rejected(
                    name,
                    rule_name,
                    "UNOBSERVED_VALUE",
                    f"规范映射中的取值未被观测到：{sanitize_value(', '.join(unobserved))}",
                    "Canonical mapping values were not observed: "
                    f"{sanitize_value(', '.join(unobserved))}",
                )
            )
            continue
        aliases = [
            alias
            for alias in dict.fromkeys(entry.aliases)
            if alias != entry.target and alias not in seen_aliases and alias not in canonical
        ]
        if not aliases or entry.target in seen_aliases:
            continue
        seen_aliases.update(aliases)
        canonical[entry.target] = aliases
        accepted.append(
            _accepted(
                name,
                rule_name,
                {"target": entry.target, "aliases": aliases},
                "规范值与别名",
                "canonical target and aliases",
                draft_field,
                refs,
            )
        )
    if canonical:
        rule = rule.model_copy(update={"canonical": canonical, "semantic": True})
        accepted.append(
            _accepted(
                name,
                "semantic",
                True,
                "允许 AI 对未列出的变体提出映射（需人工批准）",
                "AI may propose mappings for unlisted variants (human approval required)",
                None,
                refs,
            )
        )
    return rule


def validate_contract_draft(
    draft: ContractDraft, report: RunReport
) -> tuple[list[dict[str, Any]], list[RejectedRule], DataContract]:
    """Ground a draft against the report; returns (accepted, rejected, contract).

    The returned :class:`DataContract` contains only accepted rules and is guaranteed to
    round-trip through ``contract_to_yaml``/``parse_contract``.
    """
    accepted: list[dict[str, Any]] = []
    rejected: list[RejectedRule] = []
    observed = observed_values(report)
    sensitive_columns = heuristic_sensitive_columns(report)
    columns = {profile.name for profile in report.column_profiles}

    fields: dict[str, FieldRule] = {}
    seen_fields: set[str] = set()
    for draft_field in draft.fields:
        if draft_field.name in seen_fields:
            continue
        seen_fields.add(draft_field.name)
        rule = _validate_field(
            draft_field, report, observed, sensitive_columns, accepted, rejected
        )
        if rule is not None and rule != FieldRule():
            fields[draft_field.name] = rule

    business_key: list[str] = []
    for column in dict.fromkeys(draft.business_key):
        if column in columns:
            business_key.append(column)
        else:
            rejected.append(
                _rejected(
                    column,
                    "business_key",
                    "UNKNOWN_COLUMN",
                    f"业务键引用了不存在的列 `{sanitize_value(column)}`。",
                    f"business_key references unknown column `{sanitize_value(column)}`.",
                )
            )
    if business_key:
        accepted.append(
            _accepted(
                ",".join(business_key), "business_key", business_key, "业务键", "business key",
                None, [],
            )
        )

    ambiguity: dict[str, list[str]] = {}
    for entry in draft.ambiguity:
        if entry.column not in columns:
            rejected.append(
                _rejected(
                    entry.column,
                    "ambiguity",
                    "UNKNOWN_COLUMN",
                    f"歧义登记引用了不存在的列 `{sanitize_value(entry.column)}`。",
                    f"ambiguity references unknown column `{sanitize_value(entry.column)}`.",
                )
            )
            continue
        observed_here = observed.get(entry.column, set())
        tokens = [token for token in dict.fromkeys(entry.tokens) if token in observed_here]
        unobserved = [token for token in entry.tokens if token not in observed_here]
        if unobserved:
            rejected.append(
                _rejected(
                    entry.column,
                    "ambiguity",
                    "UNOBSERVED_VALUE",
                    f"歧义标记未被观测到：{sanitize_value(', '.join(unobserved))}",
                    f"Ambiguity tokens were not observed: {sanitize_value(', '.join(unobserved))}",
                )
            )
        if tokens:
            ambiguity[entry.column] = tokens
            accepted.append(
                _accepted(
                    entry.column, "ambiguity", tokens, "歧义登记（禁止自动映射）",
                    "ambiguity registry (never auto-mapped)", None, [],
                )
            )

    contract = DataContract(
        id=f"drafted-{report.profile.dataset_hash[:12]}",
        version="0.1.0",
        title_zh="AI 起草的数据契约（待人工确认）",
        title_en="AI-drafted data contract (pending human confirmation)",
        business_key=business_key,
        fields=fields,
        ambiguity_registry=ambiguity,
        auto_authorization=AutoAuthorization(
            exact_duplicate_exclusion=True,
            category_normalization=True,
            date_standardization=True,
        ),
    )
    # Guarantee: the YAML we hand to the human parses back into the same contract.
    parse_contract(contract_to_yaml(contract))
    return accepted, rejected, contract


# --------------------------------------------------------------------------------------
# 3. release brief
# --------------------------------------------------------------------------------------

_FULLWIDTH_DIGITS = str.maketrans("０１２３４５６７８９．，％", "0123456789.,%")
_VERSION_LIKE = re.compile(r"\d+(?:\.\d+){2,}")
_NUMBER_TOKEN = re.compile(r"\d[\d,]*(?:\.\d+)?")


def number_tokens(text: str) -> list[str]:
    """Numeric tokens in ``text`` with full-width digits folded and version strings skipped."""
    folded = text.translate(_FULLWIDTH_DIGITS)
    scrubbed = _VERSION_LIKE.sub(" ", folded)
    return [token.rstrip(",.") for token in _NUMBER_TOKEN.findall(scrubbed) if token.strip(",.")]


def _as_decimal(token: str) -> Decimal | None:
    try:
        return Decimal(token.replace(",", "").rstrip("%"))
    except InvalidOperation:
        return None


def _fact_decimals(facts: dict[str, Any]) -> list[Decimal]:
    values: list[Decimal] = []
    for value in facts.values():
        if isinstance(value, bool) or value is None:
            continue
        if isinstance(value, int | float):
            values.append(Decimal(str(value)))
    return values


def _fact_strings(facts: dict[str, Any]) -> list[str]:
    strings = [value for value in facts.values() if isinstance(value, str)]
    strings.extend(facts)
    return strings


def verify_numbers(text: str, facts: dict[str, Any]) -> list[str]:
    """Number tokens in ``text`` that equal no fact value (numerically or literally)."""
    decimals = _fact_decimals(facts)
    strings = _fact_strings(facts)
    unverified: list[str] = []
    for token in number_tokens(text):
        value = _as_decimal(token)
        if value is not None and any(value == fact for fact in decimals):
            continue
        plain = token.replace(",", "")
        if any(plain in item for item in strings):
            continue
        unverified.append(token)
    return unverified


def validate_brief(
    claims: list[dict[str, Any]], facts: dict[str, Any]
) -> list[ReleaseBriefClaim]:
    verified_claims: list[ReleaseBriefClaim] = []
    for claim in claims:
        text_zh = str(claim.get("text_zh", ""))
        text_en = str(claim.get("text_en", ""))
        raw_ids = claim.get("fact_ids")
        fact_ids = [str(item) for item in raw_ids] if isinstance(raw_ids, list) else []
        reasons: list[str] = []
        unknown = [fact_id for fact_id in fact_ids if fact_id not in facts]
        if unknown:
            reasons.append(f"UNKNOWN_FACT:{','.join(unknown)}")
        bad_numbers = verify_numbers(text_zh, facts) + verify_numbers(text_en, facts)
        if bad_numbers:
            reasons.append(f"UNVERIFIED_NUMBER:{','.join(dict.fromkeys(bad_numbers))}")
        verified_claims.append(
            ReleaseBriefClaim(
                text_zh=text_zh,
                text_en=text_en,
                fact_ids=fact_ids,
                verified=not reasons,
                reason="; ".join(reasons) if reasons else None,
            )
        )
    return verified_claims
