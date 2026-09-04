"""Sensitive pattern preflight and masking (spec §3.5).

Raw matched values never leave this module unmasked: callers receive counts, pattern classes
and masks only. Patterns avoid look-around so the same text works in the Rust regex engine
used by Polars and in Python's ``re``.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

import polars as pl

_EMAIL = r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}"
_CN_ID = r"(?:^|[^0-9A-Za-z])[0-9]{17}[0-9Xx](?:[^0-9A-Za-z]|$)"
_CN_MOBILE = r"(?:^|[^0-9])1[3-9][0-9]{9}(?:[^0-9]|$)"
_BANK_CARD = r"(?:^|[^0-9])[0-9]{16,19}(?:[^0-9]|$)"
_INTL_PHONE = (
    r"(?:\+[0-9]{1,3}[ ().-]*[0-9](?:[ ().-]*[0-9]){6,13}(?:[^0-9]|$))"
    r"|(?:(?:^|[^0-9])\(?[0-9]{3}\)?[ .-][0-9]{3}[ .-][0-9]{4}(?:[^0-9]|$))"
)
_NAME_LABEL = r"(?i:name|patient|姓名)\s*[:：]\s*\S+"


@dataclass(frozen=True)
class SensitivePattern:
    pattern_class: str
    regex: str
    mask: str
    compiled: re.Pattern[str] = field(init=False, repr=False, compare=False)

    def __post_init__(self) -> None:
        object.__setattr__(self, "compiled", re.compile(self.regex))


SENSITIVE_PATTERNS: tuple[SensitivePattern, ...] = (
    SensitivePattern("email", _EMAIL, "••••@••••"),
    SensitivePattern("cn_id", _CN_ID, "••••••••••••••••••"),
    SensitivePattern("cn_mobile", _CN_MOBILE, "1••••••••••"),
    SensitivePattern("bank_card", _BANK_CARD, "•••• •••• •••• ••••"),
    SensitivePattern("intl_phone", _INTL_PHONE, "+•• ••• ••• ••••"),
    SensitivePattern("name_label", _NAME_LABEL, "•••: ••••"),
)
COMBINED_PATTERN = "|".join(f"(?:{pattern.regex})" for pattern in SENSITIVE_PATTERNS)
PATTERN_CLASSES: tuple[str, ...] = tuple(pattern.pattern_class for pattern in SENSITIVE_PATTERNS)
GENERIC_MASK = "••••"
TEXT_PATTERN_CLASS = "text"

HEURISTIC_NAME_TOKENS: tuple[str, ...] = (
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

_MASKS = {pattern.pattern_class: pattern.mask for pattern in SENSITIVE_PATTERNS}


def is_heuristic_sensitive_name(column: str) -> bool:
    lowered = column.lower()
    return any(token in lowered for token in HEURISTIC_NAME_TOKENS)


def heuristic_sensitive_columns(columns: list[str]) -> list[str]:
    return [column for column in columns if is_heuristic_sensitive_name(column)]


def classify_value(value: str | None) -> str | None:
    """First matching pattern class, or ``None`` when the value looks harmless."""
    if not value:
        return None
    for pattern in SENSITIVE_PATTERNS:
        if pattern.compiled.search(value):
            return pattern.pattern_class
    return None


def mask_value(value: str | None, pattern_class: str | None = None) -> str:
    """Fixed mask per pattern class; the input value never influences the output."""
    if value is None or value == "":
        return ""
    if pattern_class is None:
        pattern_class = classify_value(value)
    return _MASKS.get(pattern_class or "", GENERIC_MASK)


@dataclass(frozen=True)
class SensitiveScan:
    hit_count: int
    class_counts: dict[str, int]
    hit_values: list[str]


def scan_counts(values: pl.Series, counts: pl.Series) -> SensitiveScan:
    """Scan distinct ``values`` (weighted by ``counts``) for sensitive patterns.

    ``hit_values`` are returned only so the caller can locate the affected rows; they must
    never be written to a report, event, log or AI payload.
    """
    if values.len() == 0:
        return SensitiveScan(hit_count=0, class_counts={}, hit_values=[])
    mask = values.str.contains(COMBINED_PATTERN).fill_null(False)
    if not mask.any():
        return SensitiveScan(hit_count=0, class_counts={}, hit_values=[])
    hit_values = values.filter(mask).to_list()
    hit_counts = counts.filter(mask).to_list()
    class_counts: dict[str, int] = {}
    total = 0
    for value, count in zip(hit_values, hit_counts, strict=True):
        pattern_class = classify_value(str(value)) or PATTERN_CLASSES[0]
        class_counts[pattern_class] = class_counts.get(pattern_class, 0) + int(count)
        total += int(count)
    ordered = dict(sorted(class_counts.items(), key=lambda item: (-item[1], item[0])))
    return SensitiveScan(
        hit_count=total,
        class_counts=ordered,
        hit_values=[str(value) for value in hit_values],
    )
