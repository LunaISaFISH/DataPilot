"""Minimised evidence payload builders (spec §5.3) — the only thing the model may see.

Rules enforced here, by construction:

* never row-level records, only aggregated value counts (``rows_sent`` is always 0);
* sensitive columns contribute their name and pattern-class counts, never values;
* at most 30 values per column, each ≤ 64 characters, control characters stripped;
* every payload is a JSON object (data, never prose) and is hashed to ``input_hash``.
"""

from __future__ import annotations

import hashlib
import re
import unicodedata
from typing import Any

from datapilot.contracts.models import (
    ColumnProfile,
    ExecutionResult,
    RedactionSummary,
    RunReport,
    SemanticRequest,
)
from datapilot.serialization import canonical_json

MAX_VALUES_PER_COLUMN = 30
MAX_VALUE_CHARS = 64

# Column-name heuristics from spec §3.5 (PHI-<col> without a contract). Kept here so the
# redaction layer never depends on the engine package while it is being rebuilt.
SENSITIVE_NAME_HINTS: tuple[str, ...] = (
    "email",
    "phone",
    "mobile",
    "tel",
    "note",
    "remark",
    "name",
    "id_card",
    "身份证",
    "电话",
    "手机",
    "姓名",
    "备注",
)

PROFILE_FACTS: tuple[str, ...] = (
    "type",
    "null_rate",
    "distinct",
    "top_values",
    "format",
    "range",
    "sensitive_hits",
)

_CONTROL_CHARS = re.compile(r"[\x00-\x1f\x7f-\x9f\u200b-\u200f\u2028\u2029\ufeff]")
_WHITESPACE = re.compile(r"\s+")


# --------------------------------------------------------------------------------------
# text utilities
# --------------------------------------------------------------------------------------


def strip_control(value: str) -> str:
    return _CONTROL_CHARS.sub("", value)


def sanitize_value(value: str, limit: int = MAX_VALUE_CHARS) -> str:
    """Control characters removed, then truncated to ``limit`` characters."""
    return strip_control(value)[:limit]


def normalize_text(value: str) -> str:
    """casefold + strip + collapse whitespace + full-width → half-width (spec §3.5)."""
    folded = unicodedata.normalize("NFKC", strip_control(value)).casefold().strip()
    return _WHITESPACE.sub(" ", folded)


def payload_hash(payload: dict[str, Any]) -> str:
    return hashlib.sha256(canonical_json(payload).encode("utf-8")).hexdigest()


def is_sensitive_name(column: str) -> bool:
    lowered = column.casefold()
    return any(hint in lowered for hint in SENSITIVE_NAME_HINTS)


def heuristic_sensitive_columns(report: RunReport) -> set[str]:
    """Columns the deterministic side already treats as sensitive; the model may only add."""
    sensitive: set[str] = set(report.sensitive_preflight.columns_withheld)
    for profile in report.column_profiles:
        if (
            "sensitive" in profile.contract_flags
            or profile.sensitive_hit_count > 0
            or is_sensitive_name(profile.name)
        ):
            sensitive.add(profile.name)
    return sensitive


def profile_evidence_refs(column: str) -> list[str]:
    return [f"PROFILE:{column}:{fact}" for fact in PROFILE_FACTS]


# --------------------------------------------------------------------------------------
# semantic mapping
# --------------------------------------------------------------------------------------


def _clean_values(values: list[str]) -> list[str]:
    """Keep only values that survive sanitisation unchanged (they must round-trip exactly)."""
    kept: list[str] = []
    for value in values:
        if value and sanitize_value(value) == value and value not in kept:
            kept.append(value)
    return kept


def build_semantic_payload(
    request: SemanticRequest,
) -> tuple[dict[str, Any], RedactionSummary, str]:
    ordered = sorted(
        request.candidate_counts.items(), key=lambda item: (-item[1], item[0])
    )
    candidates: dict[str, int] = {}
    for value, count in ordered:
        if len(candidates) >= MAX_VALUES_PER_COLUMN:
            break
        if value and sanitize_value(value) == value:
            candidates[value] = count
    vocabulary = _clean_values(request.canonical_vocabulary)
    ambiguity = _clean_values(request.ambiguity_tokens)
    evidence_refs = _clean_values(request.evidence_refs)
    payload: dict[str, Any] = {
        "task": "semantic",
        "finding_id": sanitize_value(request.finding_id),
        "column": sanitize_value(request.column),
        "candidate_counts": candidates,
        "canonical_vocabulary": vocabulary,
        "evidence_refs": evidence_refs,
        "ambiguity_tokens": ambiguity,
        "rows_sent": 0,
    }
    sent = [*candidates, *vocabulary, *ambiguity]
    summary = RedactionSummary(
        rows_sent=0,
        columns_withheld=[],
        values_sent=len(sent),
        chars_sent=sum(len(value) for value in sent),
    )
    return payload, summary, payload_hash(payload)


# --------------------------------------------------------------------------------------
# contract drafting
# --------------------------------------------------------------------------------------


def _pattern_classes(profile: ColumnProfile) -> dict[str, int]:
    classes: dict[str, int] = {}
    for top in profile.top_values:
        if top.pattern_class:
            classes[top.pattern_class] = classes.get(top.pattern_class, 0) + top.count
    return classes


def _column_entry(
    profile: ColumnProfile, *, withheld: bool, heuristic_sensitive: bool
) -> tuple[dict[str, Any], list[str]]:
    values: list[str] = []
    top_values: list[dict[str, Any]] = []
    if not withheld:
        for top in profile.top_values[:MAX_VALUES_PER_COLUMN]:
            value = sanitize_value(top.value)
            if not value:
                continue
            top_values.append({"value": value, "count": top.count})
            values.append(value)
    entry: dict[str, Any] = {
        "name": profile.name,
        "inferred_type": profile.inferred_type,
        "null_count": profile.null_count,
        "null_rate": round(profile.null_rate, 6),
        "distinct_count": profile.distinct_count,
        "max_length": profile.max_length,
        "min": None if withheld or profile.min is None else sanitize_value(profile.min),
        "max": None if withheld or profile.max is None else sanitize_value(profile.max),
        "top_values": top_values,
        "format_patterns": [
            {"pattern": sanitize_value(item.pattern), "count": item.count}
            for item in profile.format_patterns
        ],
        "sensitive_hit_count": profile.sensitive_hit_count,
        "pattern_classes": _pattern_classes(profile),
        "heuristic_sensitive": heuristic_sensitive,
        "values_withheld": withheld,
        "evidence_refs": profile_evidence_refs(profile.name),
    }
    return entry, values


def build_profile_payload(
    report: RunReport,
) -> tuple[dict[str, Any], RedactionSummary, str]:
    """Redacted column profiles: sensitive columns keep counts and pattern classes only."""
    sensitive = heuristic_sensitive_columns(report)
    columns: list[dict[str, Any]] = []
    sent: list[str] = []
    withheld: list[str] = []
    for profile in report.column_profiles:
        is_sensitive = profile.name in sensitive
        entry, values = _column_entry(
            profile, withheld=is_sensitive, heuristic_sensitive=is_sensitive
        )
        columns.append(entry)
        sent.extend(values)
        if is_sensitive:
            withheld.append(profile.name)
    payload: dict[str, Any] = {
        "task": "contract_draft",
        "record_count": report.profile.record_count,
        "column_count": report.profile.column_count,
        "columns": columns,
        "rows_sent": 0,
    }
    summary = RedactionSummary(
        rows_sent=0,
        columns_withheld=withheld,
        values_sent=len(sent),
        chars_sent=sum(len(value) for value in sent),
    )
    return payload, summary, payload_hash(payload)


def observed_values(report: RunReport) -> dict[str, set[str]]:
    """Values the model was shown per column (empty for sensitive columns)."""
    sensitive = heuristic_sensitive_columns(report)
    observed: dict[str, set[str]] = {}
    for profile in report.column_profiles:
        if profile.name in sensitive:
            observed[profile.name] = set()
            continue
        observed[profile.name] = {
            sanitize_value(top.value) for top in profile.top_values if sanitize_value(top.value)
        }
    return observed


# --------------------------------------------------------------------------------------
# release brief facts
# --------------------------------------------------------------------------------------

FACT_GLOSSARY: dict[str, str] = {
    "record_count": "源数据集记录总数 / total source records",
    "column_count": "字段数 / number of columns",
    "finding_total": "发现总数 / total findings",
    "finding_high": "高风险发现数 / HIGH-risk findings",
    "finding_medium": "中风险发现数 / MEDIUM-risk findings",
    "finding_low": "低风险发现数 / LOW-risk findings",
    "blocking_open": "仍处于 OPEN 的阻断性发现数 / blocking findings still OPEN",
    "release_status": "发布状态 / release status",
    "contract_id": "契约 ID / contract id",
    "contract_version": "契约版本 / contract version",
    "overall_score": "综合质量分（0–100）/ overall quality score (0–100)",
    "eligible_record_count": "可发布记录数 / records eligible for release",
    "quarantined_record_count": "隔离记录数 / quarantined records",
    "excluded_record_count": "排除记录数（精确重复）/ excluded records (exact duplicates)",
    "flagged_record_count": "标记待复核记录数 / records flagged for review",
    "excluded_column_count": "整列排除的字段数 / columns excluded from release",
    "validations_passed": "通过的校验数 / validations passed",
    "validations_total": "校验总数 / validations run",
    "ai_call_count": "本次运行的 AI 调用次数 / AI calls made in this run",
}


def _score_fact(score: float | None) -> float | None:
    return None if score is None else round(score, 2)


def build_facts_payload(
    report: RunReport,
    execution: ExecutionResult | None,
    *,
    ai_call_count: int | None = None,
) -> tuple[dict[str, Any], RedactionSummary, str]:
    """Named facts only: numbers, statuses and identifiers, never values from the data."""
    risk_counts = {"HIGH": 0, "MEDIUM": 0, "LOW": 0}
    blocking_open = 0
    for finding in report.findings:
        risk_counts[finding.risk_level.value] += 1
        if finding.blocking and finding.disposition == "OPEN":
            blocking_open += 1
    facts: dict[str, Any] = {
        "record_count": report.profile.record_count,
        "column_count": report.profile.column_count,
        "finding_total": len(report.findings),
        "finding_high": risk_counts["HIGH"],
        "finding_medium": risk_counts["MEDIUM"],
        "finding_low": risk_counts["LOW"],
        "blocking_open": blocking_open,
        "release_status": report.release_status.value,
        "contract_id": report.contract.id,
        "contract_version": report.contract.version,
        "overall_score": _score_fact(report.profile.overall_score),
    }
    for metric in report.profile.metrics:
        facts[f"metric_{metric.name}"] = _score_fact(metric.score) if metric.applicable else None
    if execution is not None:
        manifest = execution.release_manifest
        passed = sum(1 for check in execution.validations if check.passed)
        facts.update(
            {
                "release_status": manifest.release_status.value,
                "eligible_record_count": manifest.eligible_record_count,
                "quarantined_record_count": len(manifest.quarantined_record_uids),
                "excluded_record_count": len(manifest.excluded_record_uids),
                "flagged_record_count": len(manifest.flagged_record_uids),
                "excluded_column_count": len(manifest.excluded_columns),
                "validations_passed": passed,
                "validations_total": len(execution.validations),
                "candidate_overall_score": _score_fact(
                    execution.candidate_profile.overall_score
                ),
            }
        )
        for metric in execution.candidate_profile.metrics:
            facts[f"candidate_metric_{metric.name}"] = (
                _score_fact(metric.score) if metric.applicable else None
            )
    if ai_call_count is not None:
        facts["ai_call_count"] = ai_call_count
    glossary = {
        fact_id: FACT_GLOSSARY.get(fact_id, _generic_gloss(fact_id)) for fact_id in facts
    }
    payload: dict[str, Any] = {
        "task": "brief",
        "facts": facts,
        "fact_glossary": glossary,
        "rows_sent": 0,
    }
    summary = RedactionSummary(rows_sent=0, columns_withheld=[], values_sent=0, chars_sent=0)
    return payload, summary, payload_hash(payload)


def _generic_gloss(fact_id: str) -> str:
    if fact_id.startswith("candidate_metric_"):
        name = fact_id.removeprefix("candidate_metric_")
        return (
            f"处置后候选数据集的 {name} 指标（0–100）/ candidate {name} score after apply (0–100)"
        )
    if fact_id.startswith("metric_"):
        name = fact_id.removeprefix("metric_")
        return f"基线 {name} 指标（0–100）/ baseline {name} score (0–100)"
    if fact_id == "candidate_overall_score":
        return "处置后综合质量分（0–100）/ overall score after apply (0–100)"
    return fact_id
