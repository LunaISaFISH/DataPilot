"""Sensitive preflight and masking tests (spec §3.5): raw matches never leave the engine."""

from __future__ import annotations

import pytest
from datapilot.contracts.policy import parse_contract
from datapilot.engine import (
    HEURISTIC_NAME_TOKENS,
    analyze_csv,
    classify_value,
    heuristic_sensitive_columns,
    mask_value,
)
from datapilot.samples.clinical_nlp import generate_csv_bytes

from tests.test_engine import (
    GENERIC_COLUMNS,
    GENERIC_EMAIL,
    GENERIC_PHONES,
    PLANTED_SENSITIVE,
    FakeResolver,
    clinical_contract,
    generic_contract,
    generic_csv,
    generic_rows,
    rows_to_csv,
)

CN_ID = "11010519491231002X"
BANK_CARD = "6222021234567890123"


@pytest.mark.parametrize(
    ("value", "pattern_class"),
    [
        ("contact demo.patient@example.test now", "email"),
        ("13800138000", "cn_mobile"),
        ("电话：+86 13912345678", "cn_mobile"),
        (CN_ID, "cn_id"),
        (f"card {BANK_CARD}", "bank_card"),
        ("+1 202 555 0182", "intl_phone"),
        ("(202) 555-0182", "intl_phone"),
        ("Name: Example Person", "name_label"),
        ("姓名：张三", "name_label"),
        ("patient : someone", "name_label"),
    ],
)
def test_classify_value_hits(value: str, pattern_class: str) -> None:
    assert classify_value(value) == pattern_class


@pytest.mark.parametrize(
    "value",
    [
        "2026-09-01",
        "2026-09-01T08:00:00Z",
        "05/03/2026",
        "REC-01001",
        "0.72",
        "Synthetic note with no direct identifier.",
        "PROC-07",
        "1234567890",
        "",
        None,
    ],
)
def test_classify_value_ignores_ordinary_values(value: str | None) -> None:
    assert classify_value(value) is None


def test_mask_value_never_echoes_input() -> None:
    for value, pattern_class in (
        ("demo.patient@example.test", "email"),
        ("13800138000", "cn_mobile"),
        (CN_ID, "cn_id"),
        (BANK_CARD, "bank_card"),
        ("+1 202 555 0182", "intl_phone"),
        ("Name: Example Person", "name_label"),
        ("plain text in a sensitive column", "text"),
    ):
        masked = mask_value(value, pattern_class)
        assert masked
        assert "•" in masked
        assert not any(token in masked for token in value.split() if len(token) > 2)
    assert mask_value("13800138000") == "1••••••••••"  # class inferred
    assert mask_value("") == ""
    assert mask_value(None) == ""


def test_heuristic_column_names() -> None:
    assert heuristic_sensitive_columns(
        ["order_id", "customer_phone", "备注", "Email", "patient_name", "身份证号", "amount"]
    ) == ["customer_phone", "备注", "Email", "patient_name", "身份证号"]
    assert "id_card" in HEURISTIC_NAME_TOKENS


def test_clinical_report_json_never_contains_planted_values() -> None:
    contract = clinical_contract()
    report = analyze_csv(generate_csv_bytes(), contract)
    payload = report.model_dump_json()

    for planted in PLANTED_SENSITIVE:
        assert planted not in payload
    profile = next(p for p in report.column_profiles if p.name == "free_text_note")
    assert profile.sensitive_hit_count == 3
    assert profile.min is None and profile.max is None
    assert [value.pattern_class for value in profile.top_values][0] == "text"
    assert all("•" in value.value for value in profile.top_values)
    phi = next(f for f in report.findings if f.finding_id == "PHI-free_text_note")
    assert phi.details == {
        "declared_sensitive": True,
        "pattern_classes": {"email": 1, "intl_phone": 1, "name_label": 1},
        "hit_cell_count": 3,
        "masked": True,
        "not_sent_to_ai": True,
    }
    assert report.sensitive_preflight.columns_withheld == ["free_text_note"]
    assert report.sensitive_preflight.cells_masked == 5_200


def test_generic_report_masks_every_pattern_class() -> None:
    rows = generic_rows()
    rows[43]["备注"] = f"身份证 {CN_ID}"
    rows[44]["备注"] = f"卡号 {BANK_CARD}"
    rows[45]["备注"] = "Name: Zhang San"
    source = rows_to_csv(rows, GENERIC_COLUMNS)
    planted = (*GENERIC_PHONES, GENERIC_EMAIL, CN_ID, BANK_CARD, "Zhang San")

    for report in (analyze_csv(source), analyze_csv(source, generic_contract())):
        payload = report.model_dump_json()
        for value in planted:
            assert value not in payload
        phi = next(f for f in report.findings if f.finding_id == "PHI-备注")
        assert phi.affected_record_count == 6
        assert phi.details["pattern_classes"] == {
            "cn_mobile": 2,
            "bank_card": 1,
            "cn_id": 1,
            "email": 1,
            "name_label": 1,
        }
        profile = next(p for p in report.column_profiles if p.name == "备注")
        assert profile.sensitive_hit_count == 6
        assert all("•" in value.value for value in profile.top_values)
        assert report.sensitive_preflight.columns_withheld == ["备注"]


def test_sensitive_hits_outside_declared_columns_are_warned_and_masked() -> None:
    rows = generic_rows()
    rows[3]["tags"] = f"call {GENERIC_PHONES[0]}"
    source = rows_to_csv(rows, GENERIC_COLUMNS)
    report = analyze_csv(source, generic_contract())

    assert GENERIC_PHONES[0] not in report.model_dump_json()
    assert "PHI-tags" not in {f.finding_id for f in report.findings}
    assert any(
        "`tags`" in warning and "not declared sensitive" in warning
        for warning in report.warnings_en
    )
    assert set(report.sensitive_preflight.columns_withheld) == {"tags", "备注"}
    observational = analyze_csv(source)
    assert "PHI-tags" not in {f.finding_id for f in observational.findings}
    assert any("`tags`" in warning for warning in observational.warnings_en)


def test_declared_sensitive_column_without_hits_is_withheld_but_not_a_finding() -> None:
    contract = parse_contract(
        "id: hr\nversion: 1\nfields:\n  name: {sensitive: true}\n  dept: {required: true}\n"
    )
    report = analyze_csv(b"name,dept\nAlice,R&D\nBob,Ops\n", contract)

    assert "PHI-name" not in {f.finding_id for f in report.findings}
    assert "Alice" not in report.model_dump_json()
    assert report.sensitive_preflight.columns_withheld == ["name"]
    assert any(
        "`name`" in warning and "declared sensitive" in warning for warning in report.warnings_en
    )
    profile = next(p for p in report.column_profiles if p.name == "name")
    assert all("•" in value.value for value in profile.top_values)


def test_sensitive_hit_inside_semantic_column_withholds_it_from_ai() -> None:
    rows = generic_rows()
    rows[7]["客户"] = GENERIC_EMAIL  # a sensitive-looking value inside a semantic column
    rows[8]["客户"] = "SH"
    resolver = FakeResolver(target="上海")
    report = analyze_csv(rows_to_csv(rows, GENERIC_COLUMNS), generic_contract(), ai=resolver)

    assert resolver.requests == []
    assert GENERIC_EMAIL not in report.model_dump_json()
    assert "客户" in report.sensitive_preflight.columns_withheld
    assert any("`客户`" in warning and "skipped" in warning for warning in report.warnings_en)
    val = next(f for f in report.findings if f.finding_id == "VAL-客户")
    assert val.details["violations"]["allowed"]["record_count"] == 2  # SH and the email
    assert "examples" not in val.details["violations"]["allowed"]
    profile = next(p for p in report.column_profiles if p.name == "客户")
    assert all("•" in value.value for value in profile.top_values)


def test_semantic_candidates_skip_values_that_look_sensitive() -> None:
    contract = parse_contract(
        "id: t\nversion: 1\nfields:\n  city:\n    allowed: [上海]\n    semantic: true\n"
    )
    resolver = FakeResolver(target="上海")
    source = "city\n上海市\nSH\n13800138000\n".encode()
    report = analyze_csv(source, contract, ai=resolver)

    # The column is withheld because of the hit, so nothing reaches the resolver at all.
    assert resolver.requests == []
    assert "13800138000" not in report.model_dump_json()


def test_semantic_assessment_is_skipped_for_withheld_columns() -> None:
    contract = parse_contract(
        "id: t\nversion: 1\nfields:\n  city:\n    allowed: [上海]\n    semantic: true\n"
        "    sensitive: true\n"
    )
    resolver = FakeResolver(target="上海")
    report = analyze_csv("city\n上海市\n上海\n".encode(), contract, ai=resolver)

    assert resolver.requests == []
    assert any("semantic assessment skipped" in warning for warning in report.warnings_en)
    # Declared sensitive without pattern hits: withheld and masked, but no PHI finding (spec §3.5).
    assert {f.finding_id for f in report.findings} == {"VAL-city"}
    assert report.sensitive_preflight.columns_withheld == ["city"]


def test_generic_observational_phi_is_forbidden_and_masked() -> None:
    report = analyze_csv(generic_csv())
    phi = next(f for f in report.findings if f.finding_id == "PHI-备注")

    assert phi.authorization_mode == "FORBIDDEN"
    assert phi.allowed_outcomes == []
    assert phi.details["observational"] is True
    assert phi.details["pattern_classes"] == {"cn_mobile": 2, "email": 1}
