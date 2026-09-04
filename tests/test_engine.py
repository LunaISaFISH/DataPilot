"""Engine v2 tests (spec §3): contract-driven detectors, profiles, metrics, parsing limits."""

from __future__ import annotations

import csv
import hashlib
import io
import time
from pathlib import Path

import pytest
from datapilot.contracts.models import (
    AIProposal,
    GroundingResult,
    ReleaseStatus,
    RunReport,
    SemanticRequest,
)
from datapilot.contracts.policy import DataContract, parse_contract
from datapilot.engine import (
    AnalysisError,
    analyze_csv,
    baseline_policy,
    deterministic_mapping,
    load_policy,
    normalize_text,
    parse_csv,
    semantic_candidates,
)
from datapilot.samples.clinical_nlp import FIELDNAMES, generate_csv_bytes, generate_rows

ROOT = Path(__file__).resolve().parents[1]
CLINICAL_CONTRACT = ROOT / "fixtures" / "clinical_nlp" / "contract.yaml"
CLINICAL_POLICY_V1 = ROOT / "fixtures" / "clinical_nlp" / "policy.yaml"

# Spec §8: 20 non-glossary hypertension variants that only the AI can resolve.
SEMANTIC_VARIANTS: tuple[tuple[str, int], ...] = (
    ("high blood pressure", 9),
    ("HTN (essential)", 6),
    ("高血压", 5),
)
PLANTED_SENSITIVE = ("demo.patient@example.test", "+1 202 555 0182", "Example Person")


CLINICAL_ALLOWED_BLOCK = "    allowed:\n      - Hypertension\n      - Type 2 diabetes\n"


def clinical_contract() -> DataContract:
    """The shipped clinical contract (closed vocabulary on ``diagnosis_label``)."""
    return load_policy(CLINICAL_CONTRACT)


def closed_clinical_contract() -> DataContract:
    return clinical_contract()


def open_clinical_contract() -> DataContract:
    """The clinical contract without ``allowed`` on ``diagnosis_label`` (open vocabulary)."""
    text = CLINICAL_CONTRACT.read_text(encoding="utf-8")
    assert text.count(CLINICAL_ALLOWED_BLOCK) == 1
    return parse_contract(text.replace(CLINICAL_ALLOWED_BLOCK, ""))


def rows_to_csv(rows: list[dict[str, str]], fieldnames: list[str]) -> bytes:
    buffer = io.StringIO(newline="")
    writer = csv.DictWriter(buffer, fieldnames=fieldnames, lineterminator="\n")
    writer.writeheader()
    writer.writerows(rows)
    return buffer.getvalue().encode("utf-8")


def clinical_with_semantic_variants() -> bytes:
    """Clinical sample plus the spec §8 variants (a no-op once the generator ships them)."""
    rows = generate_rows()
    if any(row["diagnosis_label"] == SEMANTIC_VARIANTS[0][0] for row in rows):
        return rows_to_csv(rows, FIELDNAMES)
    cursor = 355
    for value, count in SEMANTIC_VARIANTS:
        for index in range(cursor, cursor + count):
            rows[index]["diagnosis_label"] = value
            rows[index]["diagnosis_code"] = "I10"
        cursor += count
    return rows_to_csv(rows, FIELDNAMES)


GENERIC_COLUMNS = [
    "order_id",
    "客户",
    "amount",
    "qty",
    "active",
    "order_date",
    "updated_at",
    "status",
    "score",
    "tags",
    "备注",
    "empty_col",
]
GENERIC_PHONES = ("13800138000", "15912345678")
GENERIC_EMAIL = "buyer@example.test"


def generic_rows() -> list[dict[str, str]]:
    rows: list[dict[str, str]] = []
    for index in range(60):
        rows.append(
            {
                "order_id": str(1000 + index),
                "客户": ("上海", "北京", "上海市", "Shanghai")[index % 4],
                "amount": f"{(index * 7) % 50 + 1}.{index % 10}",
                "qty": str(index % 5 + 1),
                "active": ("yes", "no")[index % 2],
                "order_date": f"2026-0{index % 9 + 1}-{index % 27 + 1:02d}",
                "updated_at": f"2026-09-0{index % 3 + 1}T08:{index % 60:02d}:00Z",
                "status": ("paid", "shipped")[index % 2],
                "score": f"0.{index % 100:02d}",
                "tags": ("alpha beta", "gamma", "delta epsilon")[index % 3],
                "备注": "普通备注",
                "empty_col": "",
            }
        )
    for index in range(5):  # unambiguous DD/MM/YYYY (day > 12)
        rows[index]["order_date"] = f"{13 + index:02d}/03/2026"
    for index in range(10, 13):  # negative amounts
        rows[index]["amount"] = f"-{index}.5"
    for index in range(20, 22):  # missing required status
        rows[index]["status"] = ""
    rows[30]["status"] = "PAID"
    rows[40]["备注"] = f"客户电话 {GENERIC_PHONES[0]} 请回电"
    rows[41]["备注"] = f"备用 {GENERIC_PHONES[1]}"
    rows[42]["备注"] = f"邮箱 {GENERIC_EMAIL}"
    rows.extend(dict(rows[index]) for index in range(5, 8))  # 3 exact duplicates
    return rows


def generic_csv() -> bytes:
    return rows_to_csv(generic_rows(), GENERIC_COLUMNS)


GENERIC_CONTRACT_YAML = """
id: generic-test
version: 0.1.0
business_key: [order_id]
fields:
  order_id: { required: true, unique: true, type: integer }
  客户:
    canonical: { 上海: [上海市, Shanghai] }
    allowed: [上海, 北京]
    semantic: true
  amount: { type: number, min: 0 }
  order_date: { type: date, format: "%Y-%m-%d", accept_formats: ["%d/%m/%Y"] }
  status: { required: true, allowed: [paid, shipped] }
  备注: { sensitive: true }
auto_authorization:
  exact_duplicate_exclusion: true
  category_normalization: true
  date_standardization: true
"""


def generic_contract() -> DataContract:
    return parse_contract(GENERIC_CONTRACT_YAML)


class FakeResolver:
    """Maps every candidate except ``leave`` to ``target``; records every request."""

    def __init__(
        self,
        target: str = "Hypertension",
        *,
        leave: tuple[str, ...] = (),
        grounding_valid: bool = True,
        abstain: bool = False,
        raise_error: Exception | None = None,
    ) -> None:
        self.target = target
        self.leave = leave
        self.grounding_valid = grounding_valid
        self.abstain = abstain
        self.raise_error = raise_error
        self.requests: list[SemanticRequest] = []
        self.run_ids: list[str | None] = []

    def resolve(
        self, request: SemanticRequest, *, run_id: str | None
    ) -> tuple[AIProposal, GroundingResult, str | None]:
        self.requests.append(request)
        self.run_ids.append(run_id)
        if self.raise_error is not None:
            raise self.raise_error
        mapping = {
            value: self.target for value in request.candidate_counts if value not in self.leave
        }
        proposal = AIProposal(
            finding_id=request.finding_id,
            proposed_action=None if self.abstain else "NORMALIZE_CATEGORY",
            column=request.column,
            mapping=None if self.abstain else mapping,
            evidence_refs=request.evidence_refs[:1],
            semantic_explanation="test proposal",
            ambiguity_flags=[],
            abstained=self.abstain,
            abstain_reason="test abstention" if self.abstain else None,
            provider="anthropic",
            model="claude-opus-5",
            prompt_version="semantic-test",
            input_hash="ab" * 32,
        )
        grounding = GroundingResult(
            valid=self.grounding_valid,
            reason_codes=[] if self.grounding_valid else ["UNKNOWN_CANONICAL_TARGET"],
            affected_record_count=sum(request.candidate_counts[value] for value in mapping),
        )
        return proposal, grounding, "ledger-call-1"


def findings_by_id(report: RunReport) -> dict[str, int]:
    return {finding.finding_id: finding.affected_record_count for finding in report.findings}


# --------------------------------------------------------------------------------------
# Clinical sample
# --------------------------------------------------------------------------------------


def test_clinical_sample_findings_and_counts() -> None:
    started = time.perf_counter()
    report = analyze_csv(
        generate_csv_bytes(), clinical_contract(), synthetic=True, fixture_version="clinical-nlp"
    )
    elapsed = time.perf_counter() - started

    assert findings_by_id(report) == {
        "DUP-EXACT": 43,
        "CAT-region": 61,
        "CAT-diagnosis_label": 183,
        "FMT-encounter_date": 72,
        "SEM-diagnosis_label": 20,
        "SEM-diagnosis_label-CONFLICT": 1,
        "AMB-diagnosis_label": 8,
        "MISS-diagnosis_code": 27,
        "PHI-free_text_note": 3,
    }
    assert report.release_status is ReleaseStatus.BLOCKED
    assert report.schema_version == "2.0"
    assert report.profile.record_count == 5_200
    assert report.profile.column_count == 18
    assert report.profile.source_encoding == "utf-8"
    assert report.contract.id == "clinical-nlp"
    assert report.contract.source == "uploaded"
    assert report.contract.field_count == 6
    assert report.sensitive_preflight.columns_withheld == ["free_text_note"]
    assert elapsed < 2.0
    assert sum(report.timings_ms.values()) < 2_000
    by_id = {finding.finding_id: finding for finding in report.findings}
    for finding in report.findings:
        assert finding.title_zh and finding.title_en
        assert finding.explanation_zh and finding.explanation_en
        assert len(finding.sample_record_uids) <= 20
        assert finding.sample_record_uids == finding.record_uids[:20]
        assert all(
            signal.explanation_zh and signal.explanation_en for signal in finding.evidence_signals
        )
    assert by_id["DUP-EXACT"].authorization_mode == "POLICY_AUTHORIZED"
    assert by_id["DUP-EXACT"].affected_cell_count == 0
    assert by_id["CAT-region"].details["mapping"] == {
        "NORTH": "North",
        "Northern": "North",
        "north": "North",
    }
    assert by_id["FMT-encounter_date"].details["target_format"] == "%Y-%m-%d"
    assert by_id["FMT-encounter_date"].details["source_formats"][0]["format"] == "%d/%m/%Y"
    assert by_id["SEM-diagnosis_label-CONFLICT"].blocking
    assert by_id["SEM-diagnosis_label-CONFLICT"].details["parent_finding_ids"] == [
        "CAT-diagnosis_label",
        "SEM-diagnosis_label",
    ]
    # No AI: the 20 non-glossary spellings have no approvable proposal and block the release.
    assert by_id["SEM-diagnosis_label"].allowed_outcomes == ["QUARANTINE", "REJECT_PROPOSAL"]
    assert by_id["SEM-diagnosis_label"].details["candidate_counts"] == {
        "high blood pressure": 9,
        "HTN (essential)": 6,
        "高血压": 5,
    }
    assert by_id["PHI-free_text_note"].allowed_outcomes == ["EXCLUDE", "QUARANTINE"]
    assert by_id["PHI-free_text_note"].details["pattern_classes"] == {
        "email": 1,
        "intl_phone": 1,
        "name_label": 1,
    }


def test_clinical_metrics_have_scopes() -> None:
    report = analyze_csv(generate_csv_bytes(), clinical_contract())
    metrics = {metric.name: metric for metric in report.profile.metrics}

    assert metrics["completeness"].scope_zh == "必填字段 1 个 × 5,200 行"
    assert metrics["completeness"].scope_en == "1 required field × 5,200 rows"
    assert (metrics["completeness"].numerator, metrics["completeness"].denominator) == (5173, 5200)
    assert (metrics["validity"].numerator, metrics["validity"].denominator) == (5128, 5200)
    # Closed vocabulary on diagnosis_label: everything except the 8 ambiguous tokens and the
    # 20 non-glossary spellings is in `allowed ∪ canonical targets ∪ aliases`.
    assert (metrics["consistency"].numerator, metrics["consistency"].denominator) == (
        10372,
        10400,
    )
    assert (metrics["uniqueness"].numerator, metrics["uniqueness"].denominator) == (5157, 5200)
    assert all(metric.applicable for metric in metrics.values())
    assert report.profile.overall_score is not None
    assert report.profile.overall_score == pytest.approx(99.27, abs=0.05)

    # Open vocabulary: only glossary terms count as consistent.
    opened = analyze_csv(generate_csv_bytes(), open_clinical_contract())
    consistency = next(m for m in opened.profile.metrics if m.name == "consistency")
    assert (consistency.numerator, consistency.denominator) == (5384, 10400)
    assert opened.profile.overall_score is not None
    assert opened.profile.overall_score == pytest.approx(87.28, abs=0.05)


def test_clinical_column_profiles() -> None:
    report = analyze_csv(generate_csv_bytes(), clinical_contract())
    profiles = {profile.name: profile for profile in report.column_profiles}

    assert profiles["encounter_date"].inferred_type == "date"
    assert {p.pattern: p.count for p in profiles["encounter_date"].format_patterns} == {
        "YYYY-MM-DD": 5128,
        "DD/MM/YYYY": 72,
    }
    assert profiles["encounter_date"].min == "2026-01-01"
    assert profiles["encounter_date"].max == "2026-09-27"
    assert profiles["encounter_date"].contract_flags == ["date"]
    assert profiles["updated_at"].inferred_type == "datetime"
    assert profiles["review_tier"].inferred_type == "integer"
    assert profiles["model_score"].inferred_type == "number"
    assert profiles["diagnosis_code"].null_count == 27
    assert profiles["diagnosis_code"].contract_flags == ["required"]
    assert profiles["record_id"].distinct_count == 5157
    assert profiles["free_text_note"].contract_flags == ["sensitive"]
    assert profiles["free_text_note"].sensitive_hit_count == 3
    assert all(
        value.pattern_class is not None and "•" in value.value
        for value in profiles["free_text_note"].top_values
    )
    assert set(profiles["diagnosis_label"].contract_flags) == {"canonical", "allowed", "semantic"}


def test_semantic_variants_are_resolved_by_the_ai_resolver() -> None:
    resolver = FakeResolver(leave=("Type 2 diabetes",))
    report = analyze_csv(
        clinical_with_semantic_variants(), clinical_contract(), ai=resolver, run_id="run-1"
    )

    assert resolver.run_ids == ["run-1"]
    request = resolver.requests[0]
    assert request.finding_id == "SEM-diagnosis_label"
    assert request.column == "diagnosis_label"
    # `Type 2 diabetes` is in `allowed`, so the candidates are exactly the 3 unlisted spellings.
    assert request.candidate_counts == {
        "high blood pressure": 9,
        "HTN (essential)": 6,
        "高血压": 5,
    }
    assert request.canonical_vocabulary == ["Hypertension", "Type 2 diabetes"]
    assert request.ambiguity_tokens == ["CVA", "MS", "PCP", "RA"]
    assert "EVID-CONSISTENCY-04" in request.evidence_refs
    counts = findings_by_id(report)
    assert counts["SEM-diagnosis_label"] == 20
    assert counts["CAT-diagnosis_label"] == 183
    assert counts["SEM-diagnosis_label-CONFLICT"] == 1
    sem = next(f for f in report.findings if f.finding_id == "SEM-diagnosis_label")
    assert sem.proposal is not None
    assert sem.proposal.provider == "anthropic"
    assert sem.proposal.mapping == {
        "high blood pressure": "Hypertension",
        "HTN (essential)": "Hypertension",
        "高血压": "Hypertension",
    }
    assert sem.proposal.ledger_call_id == "ledger-call-1"
    assert sem.details["resolver"] == "ai"
    assert sem.details["ai_attempt"] is None
    assert sem.allowed_outcomes == ["APPROVE_PROPOSAL", "QUARANTINE", "REJECT_PROPOSAL"]
    assert sem.proposed_action == "NORMALIZE_CATEGORY"
    assert "VAL-diagnosis_label" not in counts


def test_semantic_without_ai_on_open_vocabulary_only_warns() -> None:
    report = analyze_csv(clinical_with_semantic_variants(), open_clinical_contract())

    assert "SEM-diagnosis_label" not in findings_by_id(report)
    assert any(
        "`diagnosis_label`" in warning and "open vocabulary" in warning
        for warning in report.warnings_en
    )
    assert report.timings_ms["semantic"] == 0


def test_semantic_without_ai_has_no_approvable_proposal_for_closed_vocabulary() -> None:
    report = analyze_csv(clinical_with_semantic_variants(), closed_clinical_contract())
    sem = next(f for f in report.findings if f.finding_id == "SEM-diagnosis_label")

    assert sem.affected_record_count == 20
    assert sem.proposed_action is None
    assert sem.allowed_outcomes == ["QUARANTINE", "REJECT_PROPOSAL"]
    assert sem.proposal is not None
    assert sem.proposal.provider == "deterministic"
    assert sem.proposal.abstained is True
    assert sem.proposal.mapping is None
    assert sem.details["resolver"] == "deterministic"
    assert report.timings_ms["semantic"] == 0
    assert "VAL-diagnosis_label" not in findings_by_id(report)


def test_deterministic_fallback_maps_normalized_matches_only() -> None:
    assert normalize_text("  Ｈypertension ") == "hypertension"
    assert deterministic_mapping(
        ["hyperTENSION", "high blood pressure", "htn"],
        ["Hypertension"],
        {"HTN": "Hypertension"},
    ) == {"hyperTENSION": "Hypertension", "htn": "Hypertension"}

    rows = generate_rows()
    for index in range(355, 365):
        rows[index]["diagnosis_label"] = "hyperTENSION"
        rows[index]["diagnosis_code"] = "I10"
    report = analyze_csv(rows_to_csv(rows, FIELDNAMES), clinical_contract())
    sem = next(f for f in report.findings if f.finding_id == "SEM-diagnosis_label")

    assert sem.affected_record_count == 10
    assert sem.proposal is not None
    assert sem.proposal.provider == "deterministic"
    assert sem.proposal.mapping == {"hyperTENSION": "Hypertension"}
    assert sem.allowed_outcomes == ["APPROVE_PROPOSAL", "QUARANTINE", "REJECT_PROPOSAL"]


def test_resolver_failure_and_grounding_rejection_degrade_safely() -> None:
    source = clinical_with_semantic_variants()
    contract = closed_clinical_contract()

    failing = analyze_csv(source, contract, ai=FakeResolver(raise_error=TimeoutError("slow")))
    sem = next(f for f in failing.findings if f.finding_id == "SEM-diagnosis_label")
    assert sem.proposal is not None
    assert sem.proposal.provider == "deterministic"
    assert sem.details["ai_attempt"]["status"] == "error"
    assert sem.details["ai_attempt"]["error_type"] == "TimeoutError"
    assert any("TimeoutError" in warning for warning in failing.warnings_en)
    assert failing.release_status is ReleaseStatus.BLOCKED

    rejected = analyze_csv(source, contract, ai=FakeResolver(grounding_valid=False))
    sem = next(f for f in rejected.findings if f.finding_id == "SEM-diagnosis_label")
    assert sem.proposal is not None
    assert sem.proposal.grounding.valid is False
    assert sem.proposal.grounding.reason_codes == ["UNKNOWN_CANONICAL_TARGET"]
    assert sem.allowed_outcomes == ["QUARANTINE", "REJECT_PROPOSAL"]
    assert sem.details["ai_attempt"]["status"] == "rejected_by_grounding"

    abstained = analyze_csv(source, contract, ai=FakeResolver(abstain=True))
    sem = next(f for f in abstained.findings if f.finding_id == "SEM-diagnosis_label")
    assert sem.proposal is not None
    assert sem.proposal.abstained is True
    assert sem.details["ai_attempt"]["status"] == "abstained"


def test_semantic_candidates_helper_matches_engine() -> None:
    frame, encoding = parse_csv(clinical_with_semantic_variants())

    assert encoding == "utf-8"
    assert semantic_candidates(frame, open_clinical_contract()) == {"diagnosis_label": 4}
    assert semantic_candidates(frame, clinical_contract()) == {"diagnosis_label": 3}
    assert semantic_candidates(frame, baseline_policy()) == {}


def test_v1_policy_pack_still_loads_and_analyzes() -> None:
    contract = load_policy(CLINICAL_POLICY_V1)
    report = analyze_csv(generate_csv_bytes(), contract)
    counts = findings_by_id(report)

    assert contract.id == "clinical-nlp"
    assert counts["CAT-region"] == 61
    assert counts["CAT-diagnosis_label"] == 184
    assert counts["AMB-diagnosis_label"] == 8
    assert counts["MISS-diagnosis_code"] == 27
    assert counts["PHI-free_text_note"] == 3
    assert "SEM-diagnosis_label" not in counts  # open vocabulary, no AI, nothing mapped
    assert any("open vocabulary" in warning for warning in report.warnings_en)


# --------------------------------------------------------------------------------------
# Generic CSVs (nothing about the fixture is known to the engine)
# --------------------------------------------------------------------------------------


def test_generic_csv_without_contract_is_observational() -> None:
    report = analyze_csv(generic_csv())

    assert report.release_status is ReleaseStatus.NOT_EVALUATED
    assert report.contract.source == "baseline"
    assert report.contract.id == "baseline-observational"
    assert report.warnings_en[0].startswith("No Data Contract supplied")
    assert report.profile.record_count == 63
    assert report.profile.column_count == 12
    metrics = {metric.name: metric for metric in report.profile.metrics}
    assert metrics["completeness"].applicable is True
    assert metrics["validity"].applicable is True
    assert metrics["consistency"].applicable is False
    assert metrics["consistency"].score is None
    assert metrics["uniqueness"].applicable is True
    assert metrics["uniqueness"].numerator == 60
    assert report.profile.overall_score is not None
    counts = findings_by_id(report)
    assert counts == {"DUP-EXACT": 3, "FMT-order_date": 5, "PHI-备注": 3}
    for finding in report.findings:
        assert finding.authorization_mode == "FORBIDDEN"
        assert finding.allowed_outcomes == []
        assert finding.blocking is False
    profiles = {profile.name: profile for profile in report.column_profiles}
    assert profiles["order_id"].inferred_type == "integer"
    assert profiles["amount"].inferred_type == "number"
    assert profiles["active"].inferred_type == "boolean"
    assert profiles["order_date"].inferred_type == "date"
    assert profiles["updated_at"].inferred_type == "datetime"
    assert profiles["tags"].inferred_type == "string"
    assert profiles["empty_col"].inferred_type == "empty"
    assert profiles["empty_col"].null_rate == 1.0
    assert profiles["备注"].sensitive_hit_count == 3
    assert report.sensitive_preflight.columns_withheld == ["备注"]
    assert profiles["amount"].min == "-12.5"


def test_generic_csv_with_contract_runs_every_detector() -> None:
    report = analyze_csv(generic_csv(), generic_contract(), ai=FakeResolver(target="上海"))
    counts = findings_by_id(report)

    assert counts == {
        "DUP-EXACT": 3,
        "CAT-客户": 32,
        "FMT-order_date": 5,
        "MISS-status": 2,
        "VAL-amount": 3,
        "VAL-status": 1,
        "PHI-备注": 3,
    }
    assert report.release_status is ReleaseStatus.BLOCKED
    by_id = {finding.finding_id: finding for finding in report.findings}
    assert by_id["VAL-amount"].details["violations"]["range"]["record_count"] == 3
    assert by_id["VAL-amount"].allowed_outcomes == ["QUARANTINE", "FLAG_FOR_REVIEW"]
    assert by_id["VAL-status"].details["violations"]["allowed"]["examples"] == ["PAID"]
    assert by_id["CAT-客户"].details["mapping"] == {"Shanghai": "上海", "上海市": "上海"}
    metrics = {metric.name: metric for metric in report.profile.metrics}
    assert metrics["completeness"].scope_zh == "必填字段 2 个 × 63 行"
    assert metrics["validity"].denominator == 63 * 3  # order_id, amount, order_date
    assert metrics["consistency"].denominator == 63 + 61  # 客户 + non-empty status


def test_generic_csv_business_key_conflicts_become_dup_key() -> None:
    rows = generic_rows()
    rows[50]["order_id"] = rows[51]["order_id"]
    report = analyze_csv(rows_to_csv(rows, GENERIC_COLUMNS), generic_contract())
    dup_key = next(f for f in report.findings if f.finding_id == "DUP-KEY")

    assert dup_key.affected_record_count == 2
    assert dup_key.allowed_outcomes == ["QUARANTINE"]
    assert dup_key.details["business_key"] == ["order_id"]
    assert "VAL-order_id" not in findings_by_id(report)
    uniqueness = next(m for m in report.profile.metrics if m.name == "uniqueness")
    assert uniqueness.numerator == 63 - 3 - 1


def test_random_wide_csv_never_crashes() -> None:
    columns = [f"c{index}" for index in range(30)]
    rows = [
        {
            column: ("", "x", "1", "2.5", "2026-01-01", "yes")[(row * 7 + col) % 6]
            for col, column in enumerate(columns)
        }
        for row in range(40)
    ]
    report = analyze_csv(rows_to_csv(rows, columns))

    assert report.profile.column_count == 30
    assert report.release_status is ReleaseStatus.NOT_EVALUATED
    assert all(metric.applicable or metric.score is None for metric in report.profile.metrics)

    contract = parse_contract(
        "id: wide\nversion: 1\nfields:\n  c0: {required: true}\n  zz: {required: true}\n"
    )
    with_contract = analyze_csv(rows_to_csv(rows, columns), contract)
    assert with_contract.release_status in (ReleaseStatus.BLOCKED, ReleaseStatus.CONDITIONAL_PASS)
    assert any("`zz`" in warning for warning in with_contract.warnings_en)


def test_single_column_and_whitespace_only_values() -> None:
    report = analyze_csv(b"only\nA\n \nA\n")

    assert report.profile.record_count == 3
    assert report.column_profiles[0].null_count == 1
    assert report.column_profiles[0].distinct_count == 1
    assert findings_by_id(report) == {"DUP-EXACT": 1}


# --------------------------------------------------------------------------------------
# Parsing: encodings and limits
# --------------------------------------------------------------------------------------


def test_gb18030_and_bom_sources_are_transcoded_and_hashed_on_original_bytes() -> None:
    text = "编号,城市\n1,上海\n2,北京\n3,深圳\n"
    gbk = text.encode("gb18030")
    report = analyze_csv(gbk)
    assert report.profile.source_encoding == "gb18030"
    assert report.profile.dataset_hash == hashlib.sha256(gbk).hexdigest()
    assert [profile.name for profile in report.column_profiles] == ["编号", "城市"]

    bom = b"\xef\xbb\xbf" + text.encode("utf-8")
    assert analyze_csv(bom).profile.source_encoding == "utf-8-sig"
    assert analyze_csv(text.encode("utf-8")).profile.source_encoding == "utf-8"

    with pytest.raises(AnalysisError) as error:
        analyze_csv(b"a,b\n\xff\xff,\xff\n")
    assert error.value.code == "CSV_ENCODING_UNSUPPORTED"
    assert error.value.message_zh.startswith("仅支持 UTF-8 或 GB18030")


def test_delimiters_are_sniffed() -> None:
    tab = analyze_csv(b"a\tb\n1\t2\n")
    semicolon = analyze_csv(b"a;b\n1;2\n")

    assert [p.name for p in tab.column_profiles] == ["a", "b"]
    assert [p.name for p in semicolon.column_profiles] == ["a", "b"]


@pytest.mark.parametrize(
    ("content", "code"),
    [
        (b"", "CSV_EMPTY"),
        (b"a,,c\n1,2,3\n", "CSV_HEADER_INVALID"),
        (b"a,a\n1,2\n", "CSV_DUPLICATE_COLUMNS"),
        (b"a,b\n", "CSV_NO_RECORDS"),
        (b"a,b\n1,2,3\n", "CSV_PARSE_FAILED"),
        (
            ",".join(f"c{i}" for i in range(201)).encode()
            + b"\n"
            + b",".join(b"1" for _ in range(201))
            + b"\n",
            "CSV_TOO_MANY_COLUMNS",
        ),
    ],
)
def test_parse_limits(content: bytes, code: str) -> None:
    with pytest.raises(AnalysisError) as error:
        analyze_csv(content)
    assert error.value.code == code
    assert error.value.message_zh
    assert error.value.message_en


def test_sensitive_values_never_appear_in_report_json() -> None:
    report = analyze_csv(generate_csv_bytes(), clinical_contract())
    payload = report.model_dump_json()

    for planted in PLANTED_SENSITIVE:
        assert planted not in payload
    assert "example.test" not in payload
