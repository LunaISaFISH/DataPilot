from __future__ import annotations

from pathlib import Path

import pytest
from datapilot.contracts.policy import (
    CONTRACT_MAX_BYTES,
    ConsistentWith,
    ContractError,
    DataContract,
    FieldRule,
    baseline_contract,
    contract_hash,
    contract_to_yaml,
    parse_contract,
    translate_v1,
)

V1_PATH = Path("fixtures/clinical_nlp/policy.yaml")
V2_PATH = Path("fixtures/clinical_nlp/contract.yaml")

MINIMAL_V2 = "id: t\nversion: 1.0.0\nfields:\n  a: { required: true }\n"


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def _parse_error(text: str) -> ContractError:
    with pytest.raises(ContractError) as info:
        parse_contract(text)
    return info.value


# --------------------------------------------------------------------------------------
# v1 translation
# --------------------------------------------------------------------------------------


def test_v1_policy_still_loads_and_translates_exactly() -> None:
    v1 = parse_contract(_read(V1_PATH))
    assert v1.id == "clinical-nlp"
    assert v1.version == "1.0.0"
    assert v1.business_key == ["record_id"]
    assert v1.required_fields() == ["diagnosis_code"]
    assert v1.sensitive_fields() == ["free_text_note"]
    assert v1.semantic_columns() == ["diagnosis_label", "region"]
    assert v1.canonical_map("diagnosis_label") == {
        "HTN": "Hypertension",
        "hypertension": "Hypertension",
        "HYPERTENSION": "Hypertension",
        "Hypertension ": "Hypertension",
    }
    assert v1.allowed_values("region") == {"North", "South", "East", "West"}
    assert v1.allowed_values("diagnosis_label") is None
    # flat ambiguity list applies to every column that has canonical
    assert v1.ambiguity_tokens("diagnosis_label") == {"MS", "RA", "CVA", "PCP"}
    assert v1.ambiguity_tokens("region") == {"MS", "RA", "CVA", "PCP"}
    assert v1.ambiguity_tokens("diagnosis_code") == set()
    assert v1.auto_authorization.exact_duplicate_exclusion is True
    assert v1.auto_authorization.category_normalization is True
    assert v1.auto_authorization.date_standardization is True
    assert v1.score.weights.completeness == pytest.approx(0.30)
    assert v1.date_fields() == {}
    assert not v1.is_observational


def test_v1_translation_is_golden_against_v2_contract() -> None:
    """The translated v1 must equal the v2 fixture minus the v2-only additions."""
    v1 = parse_contract(_read(V1_PATH))
    v2 = parse_contract(_read(V2_PATH))

    # v2-only additions on the clinical contract: `consistent_with` and the closed vocabulary
    # (`allowed`) on diagnosis_label, plus the encounter_date / record_id rules.
    v2_fields = {
        name: rule.model_copy(
            update={
                "consistent_with": None,
                "allowed": None if name == "diagnosis_label" else rule.allowed,
            }
        )
        for name, rule in v2.fields.items()
        if name not in {"encounter_date", "record_id"}
    }
    assert v1.fields == v2_fields
    assert v1.business_key == v2.business_key
    assert v1.score == v2.score
    assert v1.auto_authorization == v2.auto_authorization
    assert v1.ambiguity_registry["diagnosis_label"] == v2.ambiguity_registry["diagnosis_label"]
    assert set(v2.ambiguity_registry) == {"diagnosis_label"}


def test_v2_clinical_contract_extras() -> None:
    v2 = parse_contract(_read(V2_PATH))
    assert v2.fields["diagnosis_label"].consistent_with == ConsistentWith(
        column="diagnosis_code", expected={"Hypertension": ["I10"]}
    )
    assert v2.consistency_rules().keys() == {"diagnosis_label"}
    assert v2.unique_fields() == ["record_id"]
    assert v2.required_fields() == ["diagnosis_code"]
    date_rules = v2.date_fields()
    assert list(date_rules) == ["encounter_date"]
    assert date_rules["encounter_date"].format == "%Y-%m-%d"
    assert date_rules["encounter_date"].accept_formats == ["%d/%m/%Y"]
    assert v2.vocabulary("region") == {
        "North", "South", "East", "West", "north", "NORTH", "Northern"
    }
    assert v2.vocabulary_columns() == ["diagnosis_label", "region"]
    assert v2.fields["region"].flags() == ["canonical", "allowed", "semantic"]
    assert v2.fields["free_text_note"].flags() == ["sensitive"]
    assert v2.field_count == 6


def test_translate_v1_maps_authorization_keys_and_rejects_unknown() -> None:
    translated = translate_v1(
        {
            "id": "x",
            "version": "1",
            "auto_authorization": {"region_normalization": False},
        }
    )
    assert translated["auto_authorization"] == {"category_normalization": False}
    with pytest.raises(ContractError) as info:
        translate_v1({"id": "x", "version": "1", "auto_authorization": {"anything": True}})
    assert info.value.code == "CONTRACT_SCHEMA_INVALID"


def test_v1_detection_by_flat_ambiguity_list() -> None:
    contract = parse_contract("id: a\nversion: '1'\nambiguity_registry: [SZ]\n")
    assert contract.ambiguity_registry == {}
    assert contract.is_observational


# --------------------------------------------------------------------------------------
# Errors and limits
# --------------------------------------------------------------------------------------


def test_invalid_yaml() -> None:
    error = _parse_error("id: [unclosed\nversion: 1")
    assert error.code == "CONTRACT_YAML_INVALID"
    assert error.message_zh and error.message_en


def test_non_mapping_documents() -> None:
    assert _parse_error("- just\n- a list\n").code == "CONTRACT_NOT_MAPPING"
    assert _parse_error("plain string").code == "CONTRACT_NOT_MAPPING"
    assert _parse_error("").code == "CONTRACT_NOT_MAPPING"


def test_size_limit() -> None:
    padding = "# " + "x" * CONTRACT_MAX_BYTES + "\n"
    assert _parse_error(MINIMAL_V2 + padding).code == "CONTRACT_TOO_LARGE"


def test_schema_errors() -> None:
    assert _parse_error("version: 1.0.0\nfields: {}\n").code == "CONTRACT_SCHEMA_INVALID"
    assert _parse_error("id: a\nversion: '1'\nfields:\n  c: { nope: 1 }\n").code == (
        "CONTRACT_SCHEMA_INVALID"
    )
    assert _parse_error("id: a\nversion: '1'\nfields:\n  c: { type: money }\n").code == (
        "CONTRACT_SCHEMA_INVALID"
    )
    assert _parse_error("id: a\nversion: '1'\nfields: {}\nrequired_fields: [a]\n").code == (
        "CONTRACT_MIXED_VERSIONS"
    )


def test_field_limit() -> None:
    fields = "\n".join(f"  f{i}: {{ required: true }}" for i in range(201))
    assert _parse_error(f"id: a\nversion: '1'\nfields:\n{fields}\n").code == (
        "CONTRACT_TOO_MANY_FIELDS"
    )


def test_allowed_limit() -> None:
    allowed = ", ".join(f"v{i}" for i in range(201))
    text = f"id: a\nversion: '1'\nfields:\n  c: {{ allowed: [{allowed}] }}\n"
    assert _parse_error(text).code == "CONTRACT_TOO_MANY_ALLOWED"


def test_alias_limit() -> None:
    aliases = ", ".join(f"a{i}" for i in range(501))
    text = f"id: a\nversion: '1'\nfields:\n  c:\n    canonical: {{ T: [{aliases}] }}\n"
    assert _parse_error(text).code == "CONTRACT_TOO_MANY_ALIASES"


def test_semantic_errors() -> None:
    base = "id: a\nversion: '1'\nfields:\n"
    assert _parse_error(base + "  c: { pattern: '[' }\n").code == "CONTRACT_PATTERN_INVALID"
    assert _parse_error(base + "  c: { type: date, format: ISO }\n").code == (
        "CONTRACT_FORMAT_INVALID"
    )
    assert _parse_error(base + "  c: { format: '%Y' }\n").code == "CONTRACT_FORMAT_INVALID"
    assert _parse_error(base + "  c: { type: number, min: 5, max: 1 }\n").code == (
        "CONTRACT_RANGE_INVALID"
    )
    assert _parse_error(
        base + "  c:\n    canonical: { A: [x], B: [x] }\n"
    ).code == "CONTRACT_ALIAS_CONFLICT"
    assert _parse_error(
        base + "  c:\n    canonical: { A: [x] }\n    consistent_with: { column: c, expected: {} }\n"
    ).code == "CONTRACT_CONSISTENCY_INVALID"
    assert _parse_error(
        base + "  c:\n    consistent_with: { column: d, expected: {} }\n"
    ).code == "CONTRACT_CONSISTENCY_INVALID"
    weights = "score:\n  weights: { completeness: 0, validity: 0, consistency: 0, uniqueness: 0 }\n"
    assert _parse_error(f"id: a\nversion: '1'\n{weights}").code == "CONTRACT_WEIGHTS_INVALID"


def test_yaml_scalars_are_coerced_to_strings() -> None:
    contract = parse_contract(
        "id: a\nversion: 2\nfields:\n  year: { allowed: [2024, 2025] }\n"
        "  flag:\n    canonical: { 'true': [yes] }\nambiguity_registry: { year: [1999] }\n"
    )
    assert contract.version == "2"
    assert contract.allowed_values("year") == {"2024", "2025"}
    assert contract.canonical_map("flag") == {"true": "true"}
    assert contract.ambiguity_tokens("year") == {"1999"}


# --------------------------------------------------------------------------------------
# Serialisation
# --------------------------------------------------------------------------------------


def test_contract_to_yaml_round_trips(tmp_path: Path) -> None:
    for text in (_read(V1_PATH), _read(V2_PATH)):
        original = parse_contract(text)
        rendered = contract_to_yaml(original)
        reparsed = parse_contract(rendered)
        assert reparsed == original
        assert contract_hash(reparsed) == contract_hash(original)
        assert contract_to_yaml(reparsed) == rendered


def test_round_trip_keeps_zero_and_trailing_space_values() -> None:
    contract = DataContract(
        id="edge",
        version="1.0.0",
        fields={
            "amount": FieldRule(type="number", min=0),
            "label": FieldRule(canonical={"Hypertension": ["Hypertension "]}, allowed=[]),
        },
    )
    rendered = contract_to_yaml(contract)
    assert "Hypertension " in rendered
    reparsed = parse_contract(rendered)
    assert reparsed.fields["amount"].min == 0
    assert reparsed.fields["label"].allowed == []
    assert reparsed == contract


def test_contract_hash_is_stable_and_content_sensitive() -> None:
    a = parse_contract(_read(V2_PATH))
    b = parse_contract(_read(V2_PATH))
    assert contract_hash(a) == contract_hash(b)
    assert len(contract_hash(a)) == 64
    # key order and omitted defaults do not change the hash
    explicit = parse_contract(
        "version: 1.0.0\nid: t\nfields:\n  a: { required: true, unique: false }\n"
    )
    assert contract_hash(explicit) == contract_hash(parse_contract(MINIMAL_V2))
    changed = parse_contract(MINIMAL_V2.replace("required: true", "required: false"))
    assert contract_hash(changed) != contract_hash(explicit)


def test_baseline_contract() -> None:
    baseline = baseline_contract()
    assert baseline.id == "baseline-observational"
    assert baseline.fields == {}
    assert baseline.is_observational
    assert baseline.required_fields() == []
    assert baseline.canonical_map("anything") == {}
    assert baseline.allowed_values("anything") is None
    assert baseline.ambiguity_tokens("anything") == set()
    assert parse_contract(contract_to_yaml(baseline)) == baseline
    assert contract_hash(baseline) == contract_hash(baseline_contract())
