"""Column profiles and metrics (spec §3.3 / §3.4).

Every per-column computation runs over the column's distinct non-empty values weighted by
their counts, so a 250k-row file costs as much as its cardinality, not its length. No
column name or value is hardcoded here; all business meaning comes from the contract.
"""

from __future__ import annotations

import hashlib
import re
import unicodedata
from dataclasses import dataclass, field
from typing import Any

import polars as pl

from datapilot.contracts.models import (
    ColumnProfile,
    FormatPattern,
    InferredType,
    MetricScore,
    ProfileSummary,
    TopValue,
)
from datapilot.contracts.policy import DataContract, FieldRule, contract_hash
from datapilot.engine.sensitive import (
    TEXT_PATTERN_CLASS,
    SensitiveScan,
    classify_value,
    mask_value,
    scan_counts,
)
from datapilot.serialization import canonical_json

TYPE_THRESHOLD = 0.98
TOP_VALUE_LIMIT = 5

PATTERN_ISO_DATETIME = "ISO-DATETIME"
PATTERN_YMD_DASH = "YYYY-MM-DD"
PATTERN_YMD_SLASH = "YYYY/MM/DD"
PATTERN_DMY_SLASH = "DD/MM/YYYY"
PATTERN_MDY_SLASH = "MM/DD/YYYY"
PATTERN_SLASH_AMBIGUOUS = "??/??/YYYY"
PATTERN_YMD_COMPACT = "YYYYMMDD"
PATTERN_DIGITS = "digits"
PATTERN_DECIMAL = "decimal"
PATTERN_BOOLEAN = "boolean"
PATTERN_TEXT = "text"
PATTERN_MIXED = "mixed"
_SLASH_PLACEHOLDER = "__SLASH__"

DATE_PATTERNS: frozenset[str] = frozenset(
    {
        PATTERN_YMD_DASH,
        PATTERN_YMD_SLASH,
        PATTERN_DMY_SLASH,
        PATTERN_MDY_SLASH,
        PATTERN_SLASH_AMBIGUOUS,
        PATTERN_YMD_COMPACT,
    }
)
# Display pattern -> strptime/chrono format (only unambiguous families).
PATTERN_FORMATS: dict[str, str] = {
    PATTERN_YMD_DASH: "%Y-%m-%d",
    PATTERN_YMD_SLASH: "%Y/%m/%d",
    PATTERN_DMY_SLASH: "%d/%m/%Y",
    PATTERN_MDY_SLASH: "%m/%d/%Y",
    PATTERN_YMD_COMPACT: "%Y%m%d",
}
DEFAULT_DATE_FORMAT = "%Y-%m-%d"
DEFAULT_DATETIME_FORMAT = "%Y-%m-%dT%H:%M:%S"

_RX_ISO_DATETIME = (
    r"^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?$"
)
_RX_YMD_DASH = r"^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$"
_RX_YMD_SLASH = r"^\d{4}/(?:0[1-9]|1[0-2])/(?:0[1-9]|[12]\d|3[01])$"
_RX_SLASH = r"^\d{2}/\d{2}/\d{4}$"
_RX_YMD_COMPACT = r"^(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])$"
_RX_DIGITS = r"^[+-]?\d+$"
_RX_DECIMAL = r"^[+-]?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][+-]?\d+)?$"
_RX_TEXT = r"^[\p{L}\p{M}\s]+$"
BOOLEAN_TOKENS: tuple[str, ...] = ("true", "false", "yes", "no", "y", "n", "t", "f", "是", "否")

_WHITESPACE = re.compile(r"\s+")


def normalize_text(value: str) -> str:
    """casefold + strip + collapse whitespace + full-width→half-width (NFKC)."""
    return _WHITESPACE.sub(" ", unicodedata.normalize("NFKC", value).casefold().strip())


@dataclass
class ColumnStats:
    """Distinct-value statistics for one column; the unit every detector works on."""

    name: str
    row_count: int
    empty_mask: pl.Series
    counts: pl.DataFrame  # columns: value (String), count (Int64), pattern (String)
    non_empty: int
    empty: int
    distinct: int
    inferred_type: InferredType
    type_match_count: int
    patterns: dict[str, int]
    max_length: int
    min_value: str | None
    max_value: str | None
    sensitive: SensitiveScan
    contract_flags: list[str] = field(default_factory=list)

    @property
    def values(self) -> pl.Series:
        return self.counts.get_column("value")

    @property
    def count_series(self) -> pl.Series:
        return self.counts.get_column("count")

    def weighted(self, mask: pl.Series) -> int:
        """Number of cells whose distinct value satisfies ``mask``."""
        if mask.len() == 0:
            return 0
        return int(self.count_series.filter(mask.fill_null(False)).sum())

    def values_where(self, mask: pl.Series) -> list[str]:
        if mask.len() == 0:
            return []
        return [str(value) for value in self.values.filter(mask.fill_null(False)).to_list()]

    def value_count(self, value: str) -> int:
        matched = self.counts.filter(pl.col("value") == value)
        return int(matched.get_column("count").sum()) if matched.height else 0


def _pattern_expr() -> pl.Expr:
    value = pl.col("value")
    return (
        pl.when(value.str.contains(_RX_ISO_DATETIME))
        .then(pl.lit(PATTERN_ISO_DATETIME))
        .when(value.str.contains(_RX_YMD_DASH))
        .then(pl.lit(PATTERN_YMD_DASH))
        .when(value.str.contains(_RX_YMD_SLASH))
        .then(pl.lit(PATTERN_YMD_SLASH))
        .when(value.str.contains(_RX_SLASH))
        .then(pl.lit(_SLASH_PLACEHOLDER))
        .when(value.str.contains(_RX_YMD_COMPACT))
        .then(pl.lit(PATTERN_YMD_COMPACT))
        .when(value.str.contains(_RX_DIGITS))
        .then(pl.lit(PATTERN_DIGITS))
        .when(value.str.contains(_RX_DECIMAL))
        .then(pl.lit(PATTERN_DECIMAL))
        .when(value.str.to_lowercase().is_in(list(BOOLEAN_TOKENS)))
        .then(pl.lit(PATTERN_BOOLEAN))
        .when(value.str.contains(_RX_TEXT))
        .then(pl.lit(PATTERN_TEXT))
        .otherwise(pl.lit(PATTERN_MIXED))
        .alias("pattern")
    )


def _resolve_slash_dates(counts: pl.DataFrame) -> pl.DataFrame:
    """Decide column-wide whether ``dd/mm/yyyy`` values are DMY, MDY or ambiguous."""
    slash = counts.filter(pl.col("pattern") == _SLASH_PLACEHOLDER)
    if slash.height == 0:
        return counts
    first = slash.get_column("value").str.slice(0, 2).cast(pl.Int32, strict=False)
    second = slash.get_column("value").str.slice(3, 2).cast(pl.Int32, strict=False)
    day_first_evidence = bool((first > 12).any())
    month_first_evidence = bool((second > 12).any())
    first_ok_as_day = bool(((first >= 1) & (first <= 31)).all())
    second_ok_as_month = bool(((second >= 1) & (second <= 12)).all())
    first_ok_as_month = bool(((first >= 1) & (first <= 12)).all())
    second_ok_as_day = bool(((second >= 1) & (second <= 31)).all())
    if day_first_evidence and not month_first_evidence and first_ok_as_day and second_ok_as_month:
        label = PATTERN_DMY_SLASH
    elif month_first_evidence and not day_first_evidence and first_ok_as_month and second_ok_as_day:
        label = PATTERN_MDY_SLASH
    elif first_ok_as_day and second_ok_as_month and first_ok_as_month and second_ok_as_day:
        label = PATTERN_SLASH_AMBIGUOUS
    else:
        label = PATTERN_MIXED
    return counts.with_columns(
        pl.when(pl.col("pattern") == _SLASH_PLACEHOLDER)
        .then(pl.lit(label))
        .otherwise(pl.col("pattern"))
        .alias("pattern")
    )


def _infer_type(patterns: dict[str, int], non_empty: int) -> tuple[InferredType, int]:
    if non_empty == 0:
        return "empty", 0
    iso_datetime = patterns.get(PATTERN_ISO_DATETIME, 0)
    dates = sum(count for pattern, count in patterns.items() if pattern in DATE_PATTERNS)
    digits = patterns.get(PATTERN_DIGITS, 0)
    decimals = digits + patterns.get(PATTERN_DECIMAL, 0)
    booleans = patterns.get(PATTERN_BOOLEAN, 0)
    threshold = TYPE_THRESHOLD * non_empty
    if iso_datetime >= threshold:
        return "datetime", iso_datetime
    if dates >= threshold:
        return "date", dates
    if digits >= threshold:
        return "integer", digits
    if decimals >= threshold:
        return "number", decimals
    if booleans >= threshold:
        return "boolean", booleans
    return "string", non_empty


def date_parse_expr(value: pl.Expr, patterns: dict[str, int]) -> pl.Expr:
    """Coalesced date parse over the unambiguous families observed in the column."""
    attempts = [
        value.str.to_date(fmt, strict=False)
        for pattern, fmt in PATTERN_FORMATS.items()
        if patterns.get(pattern, 0) > 0
    ]
    if not attempts:
        attempts = [value.str.to_date(DEFAULT_DATE_FORMAT, strict=False)]
    return pl.coalesce(attempts)


def _min_max(
    counts: pl.DataFrame, inferred: InferredType, patterns: dict[str, int]
) -> tuple[str | None, str | None]:
    if counts.height == 0:
        return None, None
    value = pl.col("value")
    if inferred in ("integer", "number"):
        numeric = counts.select(value.cast(pl.Float64, strict=False).alias("n")).get_column("n")
        if numeric.null_count() == numeric.len():
            return None, None
        return (
            str(counts.get_column("value")[int(numeric.arg_min() or 0)]),
            str(counts.get_column("value")[int(numeric.arg_max() or 0)]),
        )
    if inferred == "date":
        parsed = counts.select(date_parse_expr(value, patterns).alias("d")).get_column("d")
        if parsed.null_count() == parsed.len():
            return None, None
        low, high = parsed.min(), parsed.max()
        return (
            low.isoformat() if low is not None else None,  # type: ignore[union-attr]
            high.isoformat() if high is not None else None,  # type: ignore[union-attr]
        )
    if inferred == "datetime":
        iso = counts.filter(pl.col("pattern") == PATTERN_ISO_DATETIME).get_column("value")
        if iso.len() == 0:
            return None, None
        return str(iso.min()), str(iso.max())
    return None, None


def compute_column_stats(frame: pl.DataFrame) -> list[ColumnStats]:
    stats: list[ColumnStats] = []
    rows = frame.height
    for name in frame.columns:
        series = frame.get_column(name)
        empty_mask = (series.is_null() | (series.str.strip_chars() == "")).fill_null(True)
        empty = int(empty_mask.sum())
        non_empty = rows - empty
        counts = (
            series.filter(~empty_mask)
            .value_counts()
            .rename({name: "value"})
            .with_columns(pl.col("count").cast(pl.Int64))
            .sort(["count", "value"], descending=[True, False])
        )
        counts = _resolve_slash_dates(counts.with_columns(_pattern_expr()))
        pattern_rows = (
            counts.group_by("pattern")
            .agg(pl.col("count").sum())
            .sort(["count", "pattern"], descending=[True, False])
        )
        patterns = {
            str(pattern): int(count)
            for pattern, count in zip(
                pattern_rows.get_column("pattern").to_list(),
                pattern_rows.get_column("count").to_list(),
                strict=True,
            )
        }
        inferred, type_match = _infer_type(patterns, non_empty)
        length_max = counts.get_column("value").str.len_chars().max() if non_empty else 0
        max_length = int(length_max) if isinstance(length_max, int) else 0
        low, high = _min_max(counts, inferred, patterns)
        sensitive = scan_counts(counts.get_column("value"), counts.get_column("count"))
        stats.append(
            ColumnStats(
                name=name,
                row_count=rows,
                empty_mask=empty_mask,
                counts=counts,
                non_empty=non_empty,
                empty=empty,
                distinct=counts.height,
                inferred_type=inferred,
                type_match_count=type_match,
                patterns=patterns,
                max_length=max_length,
                min_value=low,
                max_value=high,
                sensitive=sensitive,
            )
        )
    return stats


# --------------------------------------------------------------------------------------
# Contract-driven validity helpers (shared by metrics and the VAL / FMT detectors)
# --------------------------------------------------------------------------------------


def has_validity_constraints(rule: FieldRule) -> bool:
    return (
        rule.type is not None
        or rule.min is not None
        or rule.max is not None
        or rule.max_length is not None
        or rule.pattern is not None
    )


def type_mask(stats: ColumnStats, rule: FieldRule) -> pl.Series:
    """True for distinct values conforming to ``rule.type`` (and ``format`` for dates)."""
    value = pl.col("value")
    if rule.type == "integer":
        expr = value.str.contains(_RX_DIGITS)
    elif rule.type == "number":
        expr = value.str.contains(_RX_DECIMAL)
    elif rule.type == "boolean":
        expr = value.str.to_lowercase().is_in(list(BOOLEAN_TOKENS))
    elif rule.type == "date":
        if rule.format is not None:
            expr = value.str.to_date(rule.format, strict=False).is_not_null()
        else:
            expr = pl.col("pattern").is_in(sorted(DATE_PATTERNS - {PATTERN_SLASH_AMBIGUOUS}))
    elif rule.type == "datetime":
        if rule.format is not None:
            expr = value.str.to_datetime(rule.format, strict=False).is_not_null()
        else:
            expr = value.str.contains(_RX_ISO_DATETIME)
    else:
        expr = pl.lit(True)
    try:
        return stats.counts.select(expr.alias("m")).get_column("m").fill_null(False)
    except pl.exceptions.PolarsError:
        return pl.Series("m", [False] * stats.counts.height, dtype=pl.Boolean)


def format_masks(stats: ColumnStats, formats: list[str], *, datetime: bool) -> list[pl.Series]:
    """One boolean mask per format: distinct values that parse under that format."""
    masks: list[pl.Series] = []
    value = pl.col("value")
    for fmt in formats:
        expr = (
            value.str.to_datetime(fmt, strict=False)
            if datetime
            else value.str.to_date(fmt, strict=False)
        ).is_not_null()
        try:
            masks.append(stats.counts.select(expr.alias("m")).get_column("m").fill_null(False))
        except pl.exceptions.PolarsError:
            masks.append(pl.Series("m", [False] * stats.counts.height, dtype=pl.Boolean))
    return masks


def constraint_violations(stats: ColumnStats, rule: FieldRule) -> dict[str, pl.Series]:
    """Per constraint kind, the mask of distinct values violating it (type excluded)."""
    value = pl.col("value")
    violations: dict[str, pl.Series] = {}
    counts = stats.counts
    if counts.height == 0:
        return violations
    if rule.min is not None or rule.max is not None:
        numeric = counts.select(value.cast(pl.Float64, strict=False).alias("n")).get_column("n")
        mask = numeric.is_null()
        if rule.min is not None:
            mask = mask | (numeric < rule.min).fill_null(False)
        if rule.max is not None:
            mask = mask | (numeric > rule.max).fill_null(False)
        violations["range"] = mask
    if rule.max_length is not None:
        violations["max_length"] = (
            counts.select((value.str.len_chars() > rule.max_length).alias("m"))
            .get_column("m")
            .fill_null(False)
        )
    if rule.pattern is not None:
        try:
            mask = (
                counts.select((~value.str.contains(f"^(?:{rule.pattern})$")).alias("m"))
                .get_column("m")
                .fill_null(True)
            )
        except pl.exceptions.PolarsError:
            compiled = re.compile(rule.pattern)
            mask = pl.Series(
                "m",
                [compiled.fullmatch(str(item)) is None for item in stats.values.to_list()],
                dtype=pl.Boolean,
            )
        violations["pattern"] = mask
    return violations


def validity_mask(stats: ColumnStats, rule: FieldRule) -> pl.Series:
    """Distinct values conforming to every declared validity constraint."""
    mask = type_mask(stats, rule)
    for violation in constraint_violations(stats, rule).values():
        mask = mask & ~violation
    return mask


# --------------------------------------------------------------------------------------
# Profiles and metrics
# --------------------------------------------------------------------------------------


def build_column_profiles(
    stats: list[ColumnStats],
    contract: DataContract,
    withheld: set[str],
) -> list[ColumnProfile]:
    profiles: list[ColumnProfile] = []
    for column in stats:
        rule = contract.rule(column.name)
        flags = rule.flags() if rule is not None else []
        top = column.counts.head(TOP_VALUE_LIMIT)
        top_values: list[TopValue] = []
        for raw_value, count in zip(
            top.get_column("value").to_list(), top.get_column("count").to_list(), strict=True
        ):
            text = str(raw_value)
            pattern_class = classify_value(text)
            if column.name in withheld or pattern_class is not None:
                top_values.append(
                    TopValue(
                        value=mask_value(text, pattern_class or TEXT_PATTERN_CLASS),
                        count=int(count),
                        pattern_class=pattern_class or TEXT_PATTERN_CLASS,
                    )
                )
            else:
                top_values.append(TopValue(value=text, count=int(count), pattern_class=None))
        profiles.append(
            ColumnProfile(
                name=column.name,
                inferred_type=column.inferred_type,
                null_count=column.empty,
                null_rate=round(column.empty / column.row_count, 6) if column.row_count else 0.0,
                distinct_count=column.distinct,
                top_values=top_values,
                min=None if column.name in withheld else column.min_value,
                max=None if column.name in withheld else column.max_value,
                max_length=column.max_length,
                format_patterns=[
                    FormatPattern(pattern=pattern, count=count)
                    for pattern, count in column.patterns.items()
                ],
                sensitive_hit_count=column.sensitive.hit_count,
                contract_flags=flags,  # type: ignore[arg-type]
            )
        )
    return profiles


def _metric(
    name: str,
    numerator: int,
    denominator: int,
    scope_zh: str,
    scope_en: str,
    *,
    applicable: bool,
) -> MetricScore:
    score = None if not applicable or denominator == 0 else round(100 * numerator / denominator, 2)
    return MetricScore(
        name=name,
        numerator=numerator,
        denominator=denominator,
        score=score,
        scope_zh=scope_zh,
        scope_en=scope_en,
        applicable=applicable and denominator > 0,
    )


def evaluated_fields(frame_columns: list[str], contract: DataContract) -> list[str]:
    if contract.is_observational:
        return list(frame_columns)
    return [column for column in frame_columns if column in contract.fields]


def compute_metrics(
    stats: list[ColumnStats],
    contract: DataContract,
    *,
    row_count: int,
    exact_surplus: int,
    key_surplus: int,
) -> list[MetricScore]:
    by_name = {column.name: column for column in stats}
    observational = contract.is_observational
    rows_text = f"{row_count:,}"

    if observational:
        completeness_columns = list(by_name)
        completeness_num = sum(column.non_empty for column in stats)
        completeness = _metric(
            "completeness",
            completeness_num,
            row_count * len(completeness_columns),
            f"观测：全部字段 {len(completeness_columns)} 个 × {rows_text} 行",
            f"Observational: all {len(completeness_columns)} columns × {rows_text} rows",
            applicable=True,
        )
        typed = [column for column in stats if column.inferred_type not in ("string", "empty")]
        validity = _metric(
            "validity",
            sum(column.type_match_count for column in typed),
            sum(column.non_empty for column in typed),
            f"观测：可推断类型字段 {len(typed)} 个的非空单元格",
            f"Observational: non-empty cells of {len(typed)} typed columns",
            applicable=True,
        )
        consistency = _metric(
            "consistency",
            0,
            0,
            "不适用：无契约词表",
            "Not applicable: no contract vocabulary",
            applicable=False,
        )
    else:
        required = [name for name in contract.required_fields() if name in by_name]
        completeness = _metric(
            "completeness",
            sum(by_name[name].non_empty for name in required),
            row_count * len(required),
            f"必填字段 {len(required)} 个 × {rows_text} 行",
            f"{len(required)} required field{'s' if len(required) != 1 else ''} × {rows_text} rows",
            applicable=bool(required),
        )
        constrained = [
            name
            for name, rule in contract.fields.items()
            if name in by_name and has_validity_constraints(rule)
        ]
        validity_num = 0
        validity_den = 0
        for name in constrained:
            column = by_name[name]
            rule = contract.fields[name]
            validity_num += column.weighted(validity_mask(column, rule))
            validity_den += column.non_empty
        validity = _metric(
            "validity",
            validity_num,
            validity_den,
            f"声明约束字段 {len(constrained)} 个的非空单元格",
            f"Non-empty cells of {len(constrained)} constrained field"
            f"{'s' if len(constrained) != 1 else ''}",
            applicable=bool(constrained),
        )
        vocab_columns = [name for name in contract.vocabulary_columns() if name in by_name]
        consistency_num = 0
        consistency_den = 0
        for name in vocab_columns:
            column = by_name[name]
            vocabulary = sorted(contract.vocabulary(name))
            consistency_num += column.weighted(column.values.is_in(vocabulary))
            consistency_den += column.non_empty
        consistency = _metric(
            "consistency",
            consistency_num,
            consistency_den,
            f"词表字段 {len(vocab_columns)} 个的非空单元格",
            f"Non-empty cells of {len(vocab_columns)} vocabulary field"
            f"{'s' if len(vocab_columns) != 1 else ''}",
            applicable=bool(vocab_columns),
        )
    uniqueness = _metric(
        "uniqueness",
        max(row_count - exact_surplus - key_surplus, 0),
        row_count,
        f"{rows_text} 行 − 完全重复 {exact_surplus:,} − 业务键重复 {key_surplus:,}",
        f"{rows_text} rows − {exact_surplus:,} exact duplicates − {key_surplus:,} key duplicates",
        applicable=True,
    )
    return [completeness, validity, consistency, uniqueness]


def overall_score(metrics: list[MetricScore], contract: DataContract) -> float | None:
    weights = contract.score.weights.as_dict()
    applicable = [metric for metric in metrics if metric.applicable and metric.score is not None]
    total_weight = sum(weights.get(metric.name, 0.0) for metric in applicable)
    if total_weight <= 0:
        return None
    weighted = sum(
        float(metric.score) * weights.get(metric.name, 0.0)
        for metric in applicable
        if metric.score is not None
    )
    return round(weighted / total_weight, 2)


def scope_hash(record_uids: list[str]) -> str:
    return hashlib.sha256("\n".join(record_uids).encode()).hexdigest()


def evaluation_scope_hash(
    record_uids: list[str],
    fields: list[str],
    contract: DataContract,
) -> str:
    material: dict[str, Any] = {
        "record_uids": record_uids,
        "fields": sorted(fields),
        "business_key": list(contract.business_key),
        "contract_hash": contract_hash(contract),
        "score_version": contract.score.version,
    }
    return hashlib.sha256(canonical_json(material).encode()).hexdigest()


def build_profile(
    frame: pl.DataFrame,
    contract: DataContract,
    dataset_hash: str,
    record_uids: list[str],
    *,
    stats: list[ColumnStats] | None = None,
    exact_surplus: int,
    key_surplus: int,
    source_encoding: str = "utf-8",
) -> ProfileSummary:
    column_stats = stats if stats is not None else compute_column_stats(frame)
    metrics = compute_metrics(
        column_stats,
        contract,
        row_count=frame.height,
        exact_surplus=exact_surplus,
        key_surplus=key_surplus,
    )
    return ProfileSummary(
        dataset_hash=dataset_hash,
        record_count=frame.height,
        column_count=frame.width,
        scope_hash=scope_hash(record_uids),
        evaluation_scope_hash=evaluation_scope_hash(
            record_uids, evaluated_fields(frame.columns, contract), contract
        ),
        score_version=contract.score.version,
        metrics=metrics,
        overall_score=overall_score(metrics, contract),
        source_encoding=source_encoding,
    )
