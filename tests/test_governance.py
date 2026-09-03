from pathlib import Path

from datapilot.contracts.models import ReleaseStatus
from datapilot.engine import analyze_csv, load_policy
from datapilot.fixtures.clinical_nlp import generate_csv_bytes
from datapilot.governance import demo_decisions, execute, prepare_dry_run

POLICY = load_policy(Path("fixtures/clinical_nlp/policy.yaml"))


def test_demo_release_is_deterministic_and_reconciled() -> None:
    source = generate_csv_bytes()
    analysis = analyze_csv(
        source,
        POLICY,
        synthetic=True,
        fixture_version="clinical-nlp-1.0.0",
    )
    dry_run = prepare_dry_run(analysis, demo_decisions())

    first = execute(source, POLICY, analysis, dry_run)
    second = execute(source, POLICY, analysis, dry_run)

    assert dry_run.quarantined_record_count == 36
    assert dry_run.excluded_record_count == 43
    assert dry_run.eligible_record_count == 5_121
    assert dry_run.affected_cell_count == 316
    assert first.result.release_manifest.release_status is ReleaseStatus.CONDITIONAL_PASS
    assert first.result.release_manifest.validation_summary == {"passed": 10, "failed": 0}
    assert first.result.release_manifest.release_artifact_hash == (
        second.result.release_manifest.release_artifact_hash
    )
    assert first.result.baseline_profile.scope_hash == first.result.candidate_profile.scope_hash
    assert first.result.baseline_profile.metrics[0] == first.result.candidate_profile.metrics[0]


def test_release_excludes_sensitive_column_and_quarantined_records() -> None:
    source = generate_csv_bytes()
    analysis = analyze_csv(source, POLICY, synthetic=True)
    bundle = execute(source, POLICY, analysis, prepare_dry_run(analysis, demo_decisions()))
    release_text = bundle.release_csv.decode()

    assert "free_text_note" not in release_text.splitlines()[0]
    assert "demo.patient@example.test" not in release_text
    assert len(release_text.splitlines()) == 5_122
