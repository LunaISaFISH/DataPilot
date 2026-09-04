"""Data Contract v2: schema, v1 translation, YAML io and helper accessors.

A Data Contract is the only place business meaning comes from. Without one the engine is
observational only. This module never looks at data; it only validates the declaration.
"""

from __future__ import annotations

import hashlib
import re
from typing import Any, Literal

import yaml
from pydantic import Field, ValidationError

from datapilot.contracts.models import StrictModel
from datapilot.serialization import canonical_json

CONTRACT_MAX_BYTES = 64 * 1024
MAX_FIELDS = 200
MAX_ALLOWED_PER_FIELD = 200
MAX_ALIASES_PER_FIELD = 500
MAX_AMBIGUITY_PER_COLUMN = 200

FieldType = Literal["string", "integer", "number", "date", "datetime", "boolean"]

_V1_ONLY_KEYS = frozenset({"required_fields", "canonical", "allowed_regions", "sensitive_fields"})
_V1_AUTHORIZATION_KEYS = {
    "exact_duplicate_exclusion": "exact_duplicate_exclusion",
    "region_normalization": "category_normalization",
    "category_normalization": "category_normalization",
    "unambiguous_date_standardization": "date_standardization",
    "date_standardization": "date_standardization",
}
# v1 `allowed_regions` was a closed vocabulary for the column literally named `region`.
_V1_REGION_COLUMN = "region"


class ContractError(ValueError):
    def __init__(self, code: str, message_zh: str, message_en: str) -> None:
        self.code = code
        self.message_zh = message_zh
        self.message_en = message_en
        super().__init__(f"{code}: {message_en}")


class ScoreWeights(StrictModel):
    completeness: float = Field(default=0.30, ge=0.0)
    validity: float = Field(default=0.25, ge=0.0)
    consistency: float = Field(default=0.25, ge=0.0)
    uniqueness: float = Field(default=0.20, ge=0.0)

    def as_dict(self) -> dict[str, float]:
        return {
            "completeness": self.completeness,
            "validity": self.validity,
            "consistency": self.consistency,
            "uniqueness": self.uniqueness,
        }


class ScoreConfig(StrictModel):
    version: str = "dq-1.0"
    weights: ScoreWeights = Field(default_factory=ScoreWeights)


class ConsistentWith(StrictModel):
    column: str = Field(min_length=1)
    expected: dict[str, list[str]]


class FieldRule(StrictModel):
    required: bool = False
    unique: bool = False
    sensitive: bool = False
    type: FieldType | None = None
    format: str | None = None
    accept_formats: list[str] = Field(default_factory=list)
    allowed: list[str] | None = None
    canonical: dict[str, list[str]] = Field(default_factory=dict)
    semantic: bool = False
    consistent_with: ConsistentWith | None = None
    min: float | None = None
    max: float | None = None
    max_length: int | None = Field(default=None, ge=0)
    pattern: str | None = None

    @property
    def is_date(self) -> bool:
        return self.type in ("date", "datetime")

    def alias_map(self) -> dict[str, str]:
        """Exact alias -> canonical target."""
        return {alias: target for target, aliases in self.canonical.items() for alias in aliases}

    def vocabulary(self) -> set[str]:
        """allowed ∪ canonical targets ∪ aliases."""
        values: set[str] = set(self.allowed or [])
        for target, aliases in self.canonical.items():
            values.add(target)
            values.update(aliases)
        return values

    def flags(self) -> list[str]:
        flags: list[str] = []
        if self.required:
            flags.append("required")
        if self.unique:
            flags.append("unique")
        if self.sensitive:
            flags.append("sensitive")
        if self.canonical:
            flags.append("canonical")
        if self.allowed is not None:
            flags.append("allowed")
        if self.is_date:
            flags.append("date")
        if self.semantic:
            flags.append("semantic")
        return flags


class AutoAuthorization(StrictModel):
    exact_duplicate_exclusion: bool = False
    category_normalization: bool = False
    date_standardization: bool = False


class DataContract(StrictModel):
    id: str = Field(min_length=1, max_length=128)
    version: str = Field(min_length=1, max_length=64)
    title_zh: str | None = None
    title_en: str | None = None
    score: ScoreConfig = Field(default_factory=ScoreConfig)
    business_key: list[str] = Field(default_factory=list)
    fields: dict[str, FieldRule] = Field(default_factory=dict)
    ambiguity_registry: dict[str, list[str]] = Field(default_factory=dict)
    auto_authorization: AutoAuthorization = Field(default_factory=AutoAuthorization)

    # -- helper accessors used by the engine ------------------------------------------

    @property
    def is_observational(self) -> bool:
        return not self.fields

    @property
    def field_count(self) -> int:
        return len(self.fields)

    def rule(self, column: str) -> FieldRule | None:
        return self.fields.get(column)

    def required_fields(self) -> list[str]:
        return [name for name, rule in self.fields.items() if rule.required]

    def unique_fields(self) -> list[str]:
        return [name for name, rule in self.fields.items() if rule.unique]

    def sensitive_fields(self) -> list[str]:
        return [name for name, rule in self.fields.items() if rule.sensitive]

    def canonical_map(self, column: str) -> dict[str, str]:
        """Exact alias -> canonical target for ``column`` (empty when undeclared)."""
        rule = self.fields.get(column)
        return rule.alias_map() if rule is not None else {}

    def canonical_targets(self, column: str) -> list[str]:
        rule = self.fields.get(column)
        return list(rule.canonical) if rule is not None else []

    def allowed_values(self, column: str) -> set[str] | None:
        rule = self.fields.get(column)
        if rule is None or rule.allowed is None:
            return None
        return set(rule.allowed)

    def vocabulary(self, column: str) -> set[str]:
        rule = self.fields.get(column)
        return rule.vocabulary() if rule is not None else set()

    def ambiguity_tokens(self, column: str) -> set[str]:
        return set(self.ambiguity_registry.get(column, []))

    def date_fields(self) -> dict[str, FieldRule]:
        return {name: rule for name, rule in self.fields.items() if rule.is_date}

    def semantic_columns(self) -> list[str]:
        return [name for name, rule in self.fields.items() if rule.semantic]

    def vocabulary_columns(self) -> list[str]:
        """Columns that declare ``allowed`` or ``canonical`` (consistency metric scope)."""
        return [
            name
            for name, rule in self.fields.items()
            if rule.allowed is not None or rule.canonical
        ]

    def consistency_rules(self) -> dict[str, ConsistentWith]:
        return {
            name: rule.consistent_with
            for name, rule in self.fields.items()
            if rule.consistent_with is not None
        }


# --------------------------------------------------------------------------------------
# Parsing
# --------------------------------------------------------------------------------------


def _fail(code: str, message_zh: str, message_en: str) -> ContractError:
    return ContractError(code, message_zh, message_en)


def _scalar_to_str(value: Any) -> Any:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return str(value)
    return value


def _str_list(value: Any) -> Any:
    if isinstance(value, list):
        return [_scalar_to_str(item) for item in value]
    return value


def _str_mapping_of_lists(value: Any) -> Any:
    if isinstance(value, dict):
        return {str(_scalar_to_str(key)): _str_list(items) for key, items in value.items()}
    return value


def _normalize_scalars(raw: dict[str, Any]) -> dict[str, Any]:
    """YAML turns ``2024`` or ``yes`` into non-strings; contract vocabularies are strings."""
    out = dict(raw)
    if isinstance(out.get("version"), (int, float)):
        out["version"] = str(out["version"])
    out["business_key"] = _str_list(out.get("business_key", []))
    fields = out.get("fields")
    if isinstance(fields, dict):
        normalized_fields: dict[str, Any] = {}
        for name, rule in fields.items():
            if rule is None:
                rule = {}
            if isinstance(rule, dict):
                rule = dict(rule)
                if "allowed" in rule:
                    rule["allowed"] = _str_list(rule["allowed"])
                if "canonical" in rule:
                    rule["canonical"] = _str_mapping_of_lists(rule["canonical"])
                if "accept_formats" in rule:
                    rule["accept_formats"] = _str_list(rule["accept_formats"])
                consistent = rule.get("consistent_with")
                if isinstance(consistent, dict) and "expected" in consistent:
                    consistent = dict(consistent)
                    consistent["expected"] = _str_mapping_of_lists(consistent["expected"])
                    rule["consistent_with"] = consistent
            normalized_fields[str(_scalar_to_str(name))] = rule
        out["fields"] = normalized_fields
    if "ambiguity_registry" in out:
        out["ambiguity_registry"] = _str_mapping_of_lists(out["ambiguity_registry"])
    return out


def _expect_list(raw: dict[str, Any], key: str) -> list[Any]:
    value = raw.get(key)
    if value is None:
        return []
    if not isinstance(value, list):
        raise _fail(
            "CONTRACT_SCHEMA_INVALID",
            f"v1 契约字段 `{key}` 必须是列表。",
            f"v1 contract key `{key}` must be a list.",
        )
    return value


def _expect_mapping(raw: dict[str, Any], key: str) -> dict[str, Any]:
    value = raw.get(key)
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise _fail(
            "CONTRACT_SCHEMA_INVALID",
            f"v1 契约字段 `{key}` 必须是映射。",
            f"v1 contract key `{key}` must be a mapping.",
        )
    return value


def is_v1_document(raw: dict[str, Any]) -> bool:
    if _V1_ONLY_KEYS & set(raw):
        return True
    return isinstance(raw.get("ambiguity_registry"), list)


def translate_v1(raw: dict[str, Any]) -> dict[str, Any]:
    """Translate a v1 Policy Pack mapping into a v2 contract mapping (spec §2)."""
    if "fields" in raw:
        raise _fail(
            "CONTRACT_MIXED_VERSIONS",
            "契约同时包含 v1 与 v2 的键，无法解析。",
            "Contract mixes v1 and v2 keys and cannot be parsed.",
        )
    fields: dict[str, dict[str, Any]] = {}

    def field(name: Any) -> dict[str, Any]:
        return fields.setdefault(str(_scalar_to_str(name)), {})

    for name in _expect_list(raw, "required_fields"):
        field(name)["required"] = True
    canonical = _expect_mapping(raw, "canonical")
    for column, mapping in canonical.items():
        if not isinstance(mapping, dict):
            raise _fail(
                "CONTRACT_SCHEMA_INVALID",
                f"v1 `canonical.{column}` 必须是 目标值 -> 别名列表 的映射。",
                f"v1 `canonical.{column}` must map targets to alias lists.",
            )
        field(column)["canonical"] = mapping
        field(column)["semantic"] = True
    allowed_regions = _expect_list(raw, "allowed_regions")
    if allowed_regions:
        field(_V1_REGION_COLUMN)["allowed"] = list(allowed_regions)
    ambiguity = _expect_list(raw, "ambiguity_registry")
    registry: dict[str, list[Any]] = (
        {str(column): list(ambiguity) for column in canonical} if ambiguity else {}
    )
    for name in _expect_list(raw, "sensitive_fields"):
        field(name)["sensitive"] = True
    authorization: dict[str, Any] = {}
    for key, enabled in _expect_mapping(raw, "auto_authorization").items():
        target = _V1_AUTHORIZATION_KEYS.get(str(key))
        if target is None:
            raise _fail(
                "CONTRACT_SCHEMA_INVALID",
                f"未知的 auto_authorization 键 `{key}`。",
                f"Unknown auto_authorization key `{key}`.",
            )
        authorization[target] = enabled
    translated: dict[str, Any] = {
        "id": raw.get("id"),
        "version": raw.get("version"),
        "score": raw.get("score"),
        "business_key": _expect_list(raw, "business_key"),
        "fields": fields,
        "ambiguity_registry": registry,
        "auto_authorization": authorization,
    }
    return {key: value for key, value in translated.items() if value is not None}


def _validation_message(error: ValidationError) -> tuple[str, str]:
    first = error.errors()[0] if error.errors() else None
    if first is None:
        return ("契约结构无效。", "Contract structure is invalid.")
    location = ".".join(str(part) for part in first.get("loc", ()))
    detail = str(first.get("msg", "invalid"))
    return (
        f"契约结构无效：{location or '<root>'}：{detail}",
        f"Contract structure is invalid at {location or '<root>'}: {detail}",
    )


def _enforce_limits_and_semantics(contract: DataContract) -> None:
    if len(contract.fields) > MAX_FIELDS:
        raise _fail(
            "CONTRACT_TOO_MANY_FIELDS",
            f"契约字段数 {len(contract.fields)} 超过上限 {MAX_FIELDS}。",
            f"Contract declares {len(contract.fields)} fields; the limit is {MAX_FIELDS}.",
        )
    weights = contract.score.weights.as_dict()
    if sum(weights.values()) <= 0:
        raise _fail(
            "CONTRACT_WEIGHTS_INVALID",
            "评分权重之和必须大于 0。",
            "Score weights must sum to more than 0.",
        )
    for key in contract.business_key:
        if not key.strip():
            raise _fail(
                "CONTRACT_SCHEMA_INVALID",
                "business_key 不能包含空列名。",
                "business_key must not contain an empty column name.",
            )
    for name, rule in contract.fields.items():
        if not name.strip():
            raise _fail(
                "CONTRACT_FIELD_NAME_INVALID",
                "字段名不能为空。",
                "Field names must not be empty.",
            )
        if rule.allowed is not None and len(rule.allowed) > MAX_ALLOWED_PER_FIELD:
            raise _fail(
                "CONTRACT_TOO_MANY_ALLOWED",
                f"字段 `{name}` 的 allowed 值数量超过上限 {MAX_ALLOWED_PER_FIELD}。",
                f"Field `{name}` declares more than {MAX_ALLOWED_PER_FIELD} allowed values.",
            )
        alias_count = sum(len(aliases) for aliases in rule.canonical.values())
        if alias_count > MAX_ALIASES_PER_FIELD:
            raise _fail(
                "CONTRACT_TOO_MANY_ALIASES",
                f"字段 `{name}` 的别名数量超过上限 {MAX_ALIASES_PER_FIELD}。",
                f"Field `{name}` declares more than {MAX_ALIASES_PER_FIELD} aliases.",
            )
        seen_alias: dict[str, str] = {}
        for target, aliases in rule.canonical.items():
            for alias in aliases:
                owner = seen_alias.get(alias)
                if owner is not None and owner != target:
                    raise _fail(
                        "CONTRACT_ALIAS_CONFLICT",
                        f"字段 `{name}` 的别名 `{alias}` 同时映射到 `{owner}` 与 `{target}`。",
                        f"Field `{name}` maps alias `{alias}` to both `{owner}` and `{target}`.",
                    )
                if alias in rule.canonical and alias != target:
                    raise _fail(
                        "CONTRACT_ALIAS_CONFLICT",
                        f"字段 `{name}` 的别名 `{alias}` 同时也是规范目标值。",
                        f"Field `{name}` uses `{alias}` both as an alias and as a target.",
                    )
                seen_alias[alias] = target
        if rule.pattern is not None:
            try:
                re.compile(rule.pattern)
            except re.error as error:
                raise _fail(
                    "CONTRACT_PATTERN_INVALID",
                    f"字段 `{name}` 的 pattern 不是合法正则：{error}",
                    f"Field `{name}` pattern is not a valid regex: {error}",
                ) from error
        for fmt in [rule.format, *rule.accept_formats]:
            if fmt is not None and "%" not in fmt:
                raise _fail(
                    "CONTRACT_FORMAT_INVALID",
                    f"字段 `{name}` 的日期格式 `{fmt}` 必须是 strptime 格式。",
                    f"Field `{name}` format `{fmt}` must be a strptime format.",
                )
        if (rule.format is not None or rule.accept_formats) and not rule.is_date:
            raise _fail(
                "CONTRACT_FORMAT_INVALID",
                f"字段 `{name}` 声明了日期格式但 type 不是 date/datetime。",
                f"Field `{name}` declares a date format but its type is not date/datetime.",
            )
        if rule.min is not None and rule.max is not None and rule.min > rule.max:
            raise _fail(
                "CONTRACT_RANGE_INVALID",
                f"字段 `{name}` 的 min 大于 max。",
                f"Field `{name}` has min greater than max.",
            )
        if rule.consistent_with is not None and rule.consistent_with.column == name:
            raise _fail(
                "CONTRACT_CONSISTENCY_INVALID",
                f"字段 `{name}` 的 consistent_with 不能指向自身。",
                f"Field `{name}` consistent_with must reference a different column.",
            )
        if rule.consistent_with is not None and not rule.canonical:
            raise _fail(
                "CONTRACT_CONSISTENCY_INVALID",
                f"字段 `{name}` 的 consistent_with 需要同时声明 canonical 目标值。",
                f"Field `{name}` consistent_with requires canonical targets on the field.",
            )
    for column, tokens in contract.ambiguity_registry.items():
        if len(tokens) > MAX_AMBIGUITY_PER_COLUMN:
            raise _fail(
                "CONTRACT_TOO_MANY_AMBIGUITY_TOKENS",
                f"列 `{column}` 的歧义词数量超过上限 {MAX_AMBIGUITY_PER_COLUMN}。",
                f"Column `{column}` declares more than {MAX_AMBIGUITY_PER_COLUMN} "
                "ambiguity tokens.",
            )


def parse_contract(text: str) -> DataContract:
    """Parse a v1 or v2 contract document. Raises ``ContractError`` on any problem."""
    if len(text.encode("utf-8")) > CONTRACT_MAX_BYTES:
        raise _fail(
            "CONTRACT_TOO_LARGE",
            f"契约文件超过 {CONTRACT_MAX_BYTES // 1024} KiB 上限。",
            f"Contract exceeds the {CONTRACT_MAX_BYTES // 1024} KiB limit.",
        )
    try:
        loaded = yaml.safe_load(text)
    except yaml.YAMLError as error:
        mark = getattr(error, "problem_mark", None)
        if mark is None:
            location_zh = ""
            location_en = ""
        else:
            line = int(mark.line) + 1
            column = int(mark.column) + 1
            location_zh = f"（第 {line} 行，第 {column} 列）"
            location_en = f" (line {line}, column {column})"
        raise _fail(
            "CONTRACT_YAML_INVALID",
            f"契约不是合法的 YAML{location_zh}。",
            f"Contract is not valid YAML{location_en}.",
        ) from error
    if not isinstance(loaded, dict):
        raise _fail(
            "CONTRACT_NOT_MAPPING",
            "契约顶层必须是一个映射（键值对）。",
            "Contract top level must be a mapping.",
        )
    raw: dict[str, Any] = {str(key): value for key, value in loaded.items()}
    if is_v1_document(raw):
        raw = translate_v1(raw)
    raw = _normalize_scalars(raw)
    try:
        contract = DataContract.model_validate(raw)
    except ValidationError as error:
        message_zh, message_en = _validation_message(error)
        raise _fail("CONTRACT_SCHEMA_INVALID", message_zh, message_en) from error
    _enforce_limits_and_semantics(contract)
    return contract


# --------------------------------------------------------------------------------------
# Serialisation
# --------------------------------------------------------------------------------------


def contract_hash(contract: DataContract) -> str:
    """sha256 of the canonical JSON of the fully materialised contract (defaults included)."""
    return hashlib.sha256(
        canonical_json(contract.model_dump(mode="json")).encode("utf-8")
    ).hexdigest()


def baseline_contract() -> DataContract:
    return DataContract(
        id="baseline-observational",
        version="1.0.0",
        title_zh="基线观测契约（无业务规则）",
        title_en="Baseline observational contract (no business rules)",
    )


def contract_to_dict(contract: DataContract) -> dict[str, Any]:
    """Compact JSON-compatible mapping with stable key order; defaults omitted."""
    out: dict[str, Any] = {"id": contract.id, "version": contract.version}
    if contract.title_zh is not None:
        out["title_zh"] = contract.title_zh
    if contract.title_en is not None:
        out["title_en"] = contract.title_en
    out["score"] = contract.score.model_dump(mode="json")
    if contract.business_key:
        out["business_key"] = list(contract.business_key)
    out["fields"] = {
        name: rule.model_dump(mode="json", exclude_defaults=True)
        for name, rule in contract.fields.items()
    }
    if contract.ambiguity_registry:
        out["ambiguity_registry"] = {
            column: list(tokens) for column, tokens in contract.ambiguity_registry.items()
        }
    out["auto_authorization"] = contract.auto_authorization.model_dump(mode="json")
    return out


def contract_to_yaml(contract: DataContract) -> str:
    """YAML rendering that round-trips through ``parse_contract``."""
    return yaml.safe_dump(
        contract_to_dict(contract),
        sort_keys=False,
        allow_unicode=True,
        default_flow_style=False,
        width=100,
    )
