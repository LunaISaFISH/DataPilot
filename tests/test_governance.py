"""Governance v2 tests (spec §4): dry run, preview, execute, validations, verifier."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest
from datapilot.contracts.models import (
    DecisionOutcome,
    HumanDecision,
    NormalizeCategoryAction,
    ReleaseStatus,
)
from datapilot.contracts.policy import contract_to_yaml, parse_contract
from datapilot.engine import analyze_csv
from datapilot.engine.profile import overall_score
from datapilot.governance import (
    GovernanceError,
    action_set_hash,
    decision_set_hash,
    demo_decisions,
    execute,
    prepare_dry_run,
    preview_changes,
    verify_run,
)
from datapilot.samples.clinical_nlp import generate_csv_bytes

from tests.test_engine import (
    PLANTED_SENSITIVE,
    FakeResolver,
    clinical_contract,
    clinical_with_semantic_variants,
    closed_clinical_contract,
    generic_contract,
    generic_csv,
)

EXPECTED_VALIDATIONS = [
    "SOURCE_IMMUTABLE",
    "SCOPE_STABLE",
    "EVALUATION_SCOPE_STABLE",
    "COMPLETENESS_NOT_IMPUTED",
    "NO_UNAPPROVED_CELL_CHANGES",
    "CONFLICTS_UNCHANGED",
    "QUARANTINE_EXCLUDED",
    "DUPLICATES_EXCLUDED",
    "SENSITIVE_COLUMN_EXCLUDED",
    "ROW_RECONCILIATION",
    "FINDING_CONSERVATION",
    "ACTION_SET_HASH_MATCH",
    "CHANGE_LEDGER_RECONCILES",
    "MANIFEST_HASHES_RECOMPUTED",
]


def _decisions_without(decisions: list[HumanDecision], finding_id: str) -> list[HumanDecision]:
    return [decision for decision in decisions if decision.finding_id != finding_id]


def test_clinical_release_end_to_end_is_reconciled_and_deterministic() -> None:
    source = generate_csv_bytes()
    contract = clinical_contract()
    report = analyze_csv(source, contract)
    decisions = demo_decisions(report)
    dry_run = prepare_dry_run(report, decisions, contract, run_revision=1)

    # No AI in this test: the 20 non-glossary spellings have no approvable proposal, so the
    # demo decision quarantines them (spec §4 "AI unavailable → release still blocked").
    assert {d.finding_id: d.outcome for d in decisions} == {
        "SEM-diagnosis_label": DecisionOutcome.QUARANTINE,
        "SEM-diagnosis_label-CONFLICT": DecisionOutcome.QUARANTINE,
        "AMB-diagnosis_label": DecisionOutcome.QUARANTINE,
        "MISS-diagnosis_code": DecisionOutcome.QUARANTINE,
        "PHI-free_text_note": DecisionOutcome.EXCLUDE,
    }
    assert dry_run.eligible_record_count == 5_101
    assert dry_run.quarantined_record_count == 56
    assert dry_run.excluded_record_count == 43
    assert dry_run.affected_cell_count == 316
    assert dry_run.flagged_record_count == 0
    assert dry_run.blocking_unresolved == []
    assert dry_run.excluded_columns == ["free_text_note"]
    assert dry_run.decision_set_hash == decision_set_hash(decisions)
    assert dry_run.finding_dispositions["CAT-region"] == "POLICY_ACTION_APPROVED"
    assert dry_run.finding_dispositions["PHI-free_text_note"] == "EXCLUDED"
    policy_refs = {
        a.authorization_ref for a in dry_run.actions if a.authorization_source == "POLICY"
    }
    assert policy_refs == {
        "clinical-nlp@1.2.0:DUP-EXACT",
        "clinical-nlp@1.2.0:CAT-region",
        "clinical-nlp@1.2.0:CAT-diagnosis_label",
        "clinical-nlp@1.2.0:FMT-encounter_date",
    }

    first = execute(source, contract, report, dry_run)
    second = execute(source, contract, report, dry_run)
    manifest = first.result.release_manifest

    assert [v.check_id for v in first.result.validations] == EXPECTED_VALIDATIONS
    assert all(v.passed for v in first.result.validations), [
        (v.check_id, v.observed, v.expected) for v in first.result.validations if not v.passed
    ]
    assert all(v.message_zh and v.message_en for v in first.result.validations)
    assert manifest.release_status is ReleaseStatus.CONDITIONAL_PASS
    assert manifest.validation_summary == {"passed": 14, "failed": 0}
    assert manifest.release_artifact_hash == second.result.release_manifest.release_artifact_hash
    assert manifest.change_ledger_hash == second.result.release_manifest.change_ledger_hash
    assert manifest.release_artifact_hash == hashlib.sha256(first.release_csv).hexdigest()
    assert manifest.candidate_artifact_hash == hashlib.sha256(first.candidate_csv).hexdigest()
    assert manifest.change_ledger_hash == hashlib.sha256(first.changes_jsonl).hexdigest()
    assert manifest.contract_hash == report.contract.hash == manifest.policy_pack_hash
    assert manifest.decision_set_hash == dry_run.decision_set_hash
    assert manifest.eligible_record_count == 5_101
    assert len(manifest.quarantined_record_uids) == 56
    assert len(manifest.excluded_record_uids) == 43
    assert manifest.flagged_record_uids == []
    assert manifest.ai_call_count == 0
    assert manifest.ai_provider == "deterministic"
    assert first.result.baseline_profile.scope_hash == first.result.candidate_profile.scope_hash
    baseline = {m.name: m for m in first.result.baseline_profile.metrics}
    candidate = {m.name: m for m in first.result.candidate_profile.metrics}
    assert baseline["completeness"].numerator == candidate["completeness"].numerator
    assert candidate["validity"].numerator == 5_200  # dates standardized

    release_lines = first.release_csv.decode().splitlines()
    assert len(release_lines) == 5_102
    assert "free_text_note" not in release_lines[0].split(",")
    for planted in PLANTED_SENSITIVE:
        assert planted not in first.release_csv.decode()
        assert planted not in first.changes_jsonl.decode()
    ledger = [json.loads(line) for line in first.changes_jsonl.decode().splitlines()]
    cells = [entry for entry in ledger if entry["column"] is not None]
    memberships = [entry for entry in ledger if entry["column"] is None]
    assert len(cells) == 316
    assert {entry["after"] for entry in memberships} == {"QUARANTINED", "EXCLUDED"}
    assert len(memberships) == 56 + 43
    assert all(entry["authorization_ref"] for entry in ledger)
    assert cells[0]["display_key"].startswith("REC-")


def test_ai_proposal_is_what_gets_executed() -> None:
    source = clinical_with_semantic_variants()
    contract = clinical_contract()
    report = analyze_csv(source, contract, ai=FakeResolver(leave=("Type 2 diabetes",)))
    dry_run = prepare_dry_run(report, demo_decisions(report), contract)
    sem_actions = [a for a in dry_run.actions if a.finding_id == "SEM-diagnosis_label"]

    assert len(sem_actions) == 1
    action = sem_actions[0]
    assert action.action_type == "NORMALIZE_CATEGORY"
    assert action.authorization_source == "HUMAN"
    assert action.authorization_ref == "decision:SEM-diagnosis_label@proposal:abababababab"
    assert isinstance(action, NormalizeCategoryAction)
    assert action.mapping == {
        "high blood pressure": "Hypertension",
        "HTN (essential)": "Hypertension",
        "高血压": "Hypertension",
    }
    assert dry_run.affected_cell_count == 336
    assert dry_run.eligible_record_count == 5_121

    bundle = execute(source, contract, report, dry_run)
    manifest = bundle.result.release_manifest
    assert manifest.release_status is ReleaseStatus.CONDITIONAL_PASS
    assert all(v.passed for v in bundle.result.validations)
    assert manifest.ai_input_hashes == {"SEM-diagnosis_label": "ab" * 32}
    assert manifest.ai_call_count == 1
    assert manifest.ai_provider == "anthropic"
    assert "高血压" not in bundle.release_csv.decode()
    assert "high blood pressure" not in bundle.release_csv.decode()


def test_reject_proposal_on_blocking_finding_keeps_release_blocked() -> None:
    source = clinical_with_semantic_variants()
    contract = clinical_contract()
    report = analyze_csv(source, contract, ai=FakeResolver(leave=("Type 2 diabetes",)))
    decisions = _decisions_without(demo_decisions(report), "SEM-diagnosis_label")
    decisions.append(
        HumanDecision(
            finding_id="SEM-diagnosis_label",
            outcome=DecisionOutcome.REJECT_PROPOSAL,
            reason="业务口径待确认",
            run_revision=1,
        )
    )
    dry_run = prepare_dry_run(report, decisions, contract)

    assert dry_run.blocking_unresolved == ["SEM-diagnosis_label"]
    assert dry_run.finding_dispositions["SEM-diagnosis_label"] == "PROPOSAL_REJECTED"
    assert not any(a.finding_id == "SEM-diagnosis_label" for a in dry_run.actions)
    bundle = execute(source, contract, report, dry_run)
    assert bundle.result.release_manifest.release_status is ReleaseStatus.BLOCKED
    assert all(v.passed for v in bundle.result.validations)


def test_no_approvable_proposal_refuses_approve_and_allows_quarantine() -> None:
    source = clinical_with_semantic_variants()
    contract = closed_clinical_contract()
    report = analyze_csv(source, contract)  # no AI: SEM finding without approvable proposal
    decisions = _decisions_without(demo_decisions(report), "SEM-diagnosis_label")

    with pytest.raises(GovernanceError) as error:
        prepare_dry_run(
            report,
            [
                *decisions,
                HumanDecision(
                    finding_id="SEM-diagnosis_label",
                    outcome=DecisionOutcome.APPROVE_PROPOSAL,
                    run_revision=1,
                ),
            ],
            contract,
        )
    assert error.value.code == "OUTCOME_NOT_ALLOWED"

    dry_run = prepare_dry_run(report, demo_decisions(report), contract)
    assert dry_run.quarantined_record_count == 56
    assert dry_run.eligible_record_count == 5_101
    bundle = execute(source, contract, report, dry_run)
    assert bundle.result.release_manifest.release_status is ReleaseStatus.CONDITIONAL_PASS


def test_flag_for_review_keeps_rows_in_release_and_lists_them_in_manifest() -> None:
    source = generic_csv()
    contract = generic_contract()
    report = analyze_csv(source, contract)
    val_amount = next(f for f in report.findings if f.finding_id == "VAL-amount")
    decisions = _decisions_without(demo_decisions(report), "VAL-amount")
    decisions.append(
        HumanDecision(
            finding_id="VAL-amount",
            outcome=DecisionOutcome.FLAG_FOR_REVIEW,
            reason="标记复核",
            run_revision=1,
        )
    )
    dry_run = prepare_dry_run(report, decisions, contract)

    assert dry_run.flagged_record_count == 3
    assert dry_run.finding_dispositions["VAL-amount"] == "FLAGGED_FOR_REVIEW"
    bundle = execute(source, contract, report, dry_run)
    manifest = bundle.result.release_manifest
    assert manifest.release_status is ReleaseStatus.CONDITIONAL_PASS
    assert all(v.passed for v in bundle.result.validations)
    assert manifest.flagged_record_uids == sorted(val_amount.record_uids)
    assert set(manifest.flagged_record_uids).isdisjoint(manifest.quarantined_record_uids)
    release_text = bundle.release_csv.decode()
    assert "-10.5" in release_text and "-12.5" in release_text
    ledger = [json.loads(line) for line in bundle.changes_jsonl.decode().splitlines()]
    flagged = [entry for entry in ledger if entry["after"] == "FLAGGED"]
    assert {entry["record_uid"] for entry in flagged} == set(val_amount.record_uids)
    assert all(entry["action_type"] == "FLAG_FOR_REVIEW" for entry in flagged)


def test_generic_sample_releases_with_demo_decisions() -> None:
    source = generic_csv()
    contract = generic_contract()
    report = analyze_csv(source, contract, ai=FakeResolver(target="上海"))
    dry_run = prepare_dry_run(report, demo_decisions(report), contract)
    bundle = execute(source, contract, report, dry_run)

    assert dry_run.excluded_columns == ["备注"]
    assert all(v.passed for v in bundle.result.validations), [
        (v.check_id, v.observed, v.expected) for v in bundle.result.validations if not v.passed
    ]
    assert bundle.result.release_manifest.release_status is ReleaseStatus.CONDITIONAL_PASS
    assert "备注" not in bundle.release_csv.decode().splitlines()[0]
    assert "13800138000" not in bundle.release_csv.decode()
    assert "2026-03-13" in bundle.release_csv.decode()  # 13/03/2026 standardized


def test_human_can_veto_policy_authorized_action() -> None:
    source = generate_csv_bytes()
    contract = clinical_contract()
    report = analyze_csv(source, contract)
    decisions = [
        *demo_decisions(report),
        HumanDecision(
            finding_id="CAT-region", outcome=DecisionOutcome.REJECT_PROPOSAL, run_revision=1
        ),
    ]
    dry_run = prepare_dry_run(report, decisions, contract)

    assert dry_run.finding_dispositions["CAT-region"] == "PROPOSAL_REJECTED"
    assert dry_run.blocking_unresolved == []
    assert dry_run.affected_cell_count == 316 - 61
    bundle = execute(source, contract, report, dry_run)
    assert bundle.result.release_manifest.release_status is ReleaseStatus.CONDITIONAL_PASS
    assert all(v.passed for v in bundle.result.validations)


def test_structured_governance_errors() -> None:
    report = analyze_csv(generate_csv_bytes(), clinical_contract())
    decisions = demo_decisions(report)

    with pytest.raises(GovernanceError) as unresolved:
        prepare_dry_run(report, [], clinical_contract())
    assert unresolved.value.code == "UNRESOLVED_FINDINGS"
    assert sorted(unresolved.value.observed) == sorted(d.finding_id for d in decisions)
    assert unresolved.value.message_zh and unresolved.value.message_en

    with pytest.raises(GovernanceError) as not_allowed:
        prepare_dry_run(
            report,
            [
                *_decisions_without(decisions, "AMB-diagnosis_label"),
                HumanDecision(
                    finding_id="AMB-diagnosis_label",
                    outcome=DecisionOutcome.EXCLUDE,
                    run_revision=1,
                ),
            ],
            clinical_contract(),
        )
    assert not_allowed.value.code == "OUTCOME_NOT_ALLOWED"
    assert not_allowed.value.observed == "EXCLUDE"
    assert not_allowed.value.expected == ["QUARANTINE"]

    stale = [d.model_copy(update={"run_revision": 2}) for d in decisions]
    with pytest.raises(GovernanceError) as mismatch:
        prepare_dry_run(report, stale, clinical_contract(), run_revision=1)
    assert mismatch.value.code == "DECISION_REVISION_MISMATCH"
    assert (mismatch.value.observed, mismatch.value.expected) == (2, 1)

    dry_run = prepare_dry_run(report, decisions, clinical_contract())
    tampered_actions = dry_run.model_copy(update={"actions": dry_run.actions[:-1]})
    with pytest.raises(GovernanceError) as changed:
        execute(generate_csv_bytes(), clinical_contract(), report, tampered_actions)
    assert changed.value.code == "ACTION_SET_CHANGED"
    assert changed.value.expected == dry_run.approved_action_set_hash
    assert changed.value.observed == action_set_hash(tampered_actions.actions)

    stale_run = dry_run.model_copy(update={"run_revision": 2})
    with pytest.raises(GovernanceError) as stale_error:
        execute(generate_csv_bytes(), clinical_contract(), report, stale_run)
    assert stale_error.value.code == "STALE_DRY_RUN"


def test_tampered_source_fails_source_immutable_or_is_refused() -> None:
    source = generate_csv_bytes()
    contract = clinical_contract()
    report = analyze_csv(source, contract)
    dry_run = prepare_dry_run(report, demo_decisions(report), contract)

    flipped = bytearray(source)
    position = source.index(b"Type 2 diabetes", 200_000)
    flipped[position] = ord("X")
    bundle = execute(bytes(flipped), contract, report, dry_run)
    failed = [v.check_id for v in bundle.result.validations if not v.passed]
    assert failed == ["SOURCE_IMMUTABLE"]
    assert bundle.result.release_manifest.release_status is ReleaseStatus.BLOCKED
    observed = next(v for v in bundle.result.validations if v.check_id == "SOURCE_IMMUTABLE")
    assert observed.observed == hashlib.sha256(bytes(flipped)).hexdigest()
    assert observed.expected == report.profile.dataset_hash

    with pytest.raises(GovernanceError) as error:
        execute(source + b"extra,row\n", contract, report, dry_run)
    assert error.value.code == "SOURCE_ARTIFACT_CHANGED"


def test_preview_changes_is_bounded_and_totalled() -> None:
    source = generate_csv_bytes()
    contract = clinical_contract()
    report = analyze_csv(source, contract)
    dry_run = prepare_dry_run(report, demo_decisions(report), contract)
    preview = preview_changes(source, report, dry_run, 10, contract=contract)

    assert len(preview.changes) == 10
    assert preview.truncated is True
    assert preview.totals["CHANGED_CELLS"] == 316
    assert preview.totals["NORMALIZE_CATEGORY"] == 61 + 183
    assert preview.totals["STANDARDIZE_DATE_FORMAT"] == 72
    assert preview.totals["QUARANTINED_RECORDS"] == 56
    assert preview.totals["EXCLUDED_RECORDS"] == 43
    assert preview.totals["EXCLUDED_COLUMNS"] == 1
    first = preview.changes[0]
    assert first.display_key == "REC-00001"
    assert (first.column, first.before, first.after) == ("region", "north", "North")
    assert first.finding_id == "CAT-region"
    assert first.action_type == "NORMALIZE_CATEGORY"
    full = preview_changes(source, report, dry_run, 1_000)
    assert len(full.changes) == 316 and full.truncated is False
    assert full.changes[0].display_key == "0"  # ordinal without a contract


def test_sensitive_composite_business_key_is_masked_in_preview_and_ledger() -> None:
    source = (
        b"email,phone,id_card,tenant,city\n"
        b"alice@example.com,13800138000,00000019900101000X,tenant-a,SH\n"
    )
    contract = parse_contract(
        """id: sensitive-business-key
version: 1.0.0
business_key: [email, phone, id_card, tenant]
fields:
  email: {sensitive: true}
  phone: {sensitive: true}
  id_card: {sensitive: true}
  city:
    canonical:
      上海: [SH]
auto_authorization:
  category_normalization: true
"""
    )
    report = analyze_csv(source, contract)
    dry_run = prepare_dry_run(report, demo_decisions(report), contract)

    preview = preview_changes(source, report, dry_run, contract=contract)
    expected_key = "••••@••••|1••••••••••|••••••••••••••••••|tenant-a"
    assert [change.display_key for change in preview.changes] == [expected_key]
    assert preview.changes[0].column == "city"

    bundle = execute(source, contract, report, dry_run)
    ledger = [json.loads(line) for line in bundle.changes_jsonl.decode().splitlines()]
    assert {entry["display_key"] for entry in ledger} == {expected_key}
    serialized = preview.model_dump_json() + bundle.changes_jsonl.decode()
    for raw_value in ("alice@example.com", "13800138000", "00000019900101000X"):
        assert raw_value not in serialized


def test_candidate_overall_score_is_recomputed_after_fixed_uniqueness() -> None:
    source = "city\nSH\n上海\n".encode()
    contract = parse_contract(
        """id: candidate-score
version: 1.0.0
fields:
  city:
    canonical:
      上海: [SH]
auto_authorization:
  category_normalization: true
"""
    )
    report = analyze_csv(source, contract)
    dry_run = prepare_dry_run(report, [], contract)

    bundle = execute(source, contract, report, dry_run)
    candidate = bundle.result.candidate_profile
    uniqueness = next(metric for metric in candidate.metrics if metric.name == "uniqueness")
    assert uniqueness.score == 100.0
    assert candidate.overall_score == overall_score(candidate.metrics, contract) == 100.0


def test_verify_run_recomputes_every_hash(tmp_path: Path) -> None:
    source = clinical_with_semantic_variants()
    contract = clinical_contract()
    report = analyze_csv(source, contract, ai=FakeResolver(leave=("Type 2 diabetes",)))
    decisions = demo_decisions(report)
    dry_run = prepare_dry_run(report, decisions, contract)
    bundle = execute(source, contract, report, dry_run)

    (tmp_path / "source.csv").write_bytes(source)
    (tmp_path / "contract.yaml").write_text(contract_to_yaml(contract), encoding="utf-8")
    (tmp_path / "report.json").write_text(report.model_dump_json(), encoding="utf-8")
    (tmp_path / "decisions.json").write_text(
        json.dumps({d.finding_id: d.model_dump(mode="json") for d in decisions}), encoding="utf-8"
    )
    (tmp_path / "dry-run.json").write_text(dry_run.model_dump_json(), encoding="utf-8")
    (tmp_path / "execution.json").write_text(bundle.result.model_dump_json(), encoding="utf-8")
    (tmp_path / "release-manifest.json").write_text(
        bundle.result.release_manifest.model_dump_json(), encoding="utf-8"
    )
    (tmp_path / "candidate.csv").write_bytes(bundle.candidate_csv)
    (tmp_path / "release.csv").write_bytes(bundle.release_csv)
    (tmp_path / "changes.jsonl").write_bytes(bundle.changes_jsonl)
    (tmp_path / "redteam").mkdir()
    (tmp_path / "redteam" / "x.json").write_text("{}", encoding="utf-8")

    verified = verify_run(tmp_path)
    assert verified.ok, [
        (c.check_id, c.observed, c.expected) for c in verified.checks if not c.passed
    ]
    assert [c.check_id for c in verified.checks] == [
        "SOURCE_HASH",
        "CONTRACT_HASH",
        "ACTION_SET_HASH",
        "DECISION_SET_HASH",
        "MANIFEST_MATCHES_EXECUTION",
        "CANDIDATE_HASH",
        "RELEASE_HASH",
        "CHANGES_HASH",
        "REEXECUTION_RELEASE_HASH",
        "REEXECUTION_VALIDATIONS",
    ]
    assert all(c.message_zh and c.message_en for c in verified.checks)

    (tmp_path / "release.csv").write_bytes(bundle.release_csv + b"tampered\n")
    tampered = verify_run(tmp_path)
    assert tampered.ok is False
    assert [c.check_id for c in tampered.checks if not c.passed] == ["RELEASE_HASH"]

    (tmp_path / "decisions.json").write_text("{}", encoding="utf-8")
    assert "DECISION_SET_HASH" in [c.check_id for c in verify_run(tmp_path).checks if not c.passed]

    partial = verify_run(tmp_path / "missing")
    assert partial.ok is False
    assert partial.checks[0].check_id == "RUN_FILES_PRESENT"
