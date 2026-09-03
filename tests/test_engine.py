import csv
import hashlib
import io

import pytest
from datapilot.contracts.models import ReleaseStatus
from datapilot.engine import analyze_csv
from datapilot.serialization import canonical_json


def test_fixture_is_stable_and_has_expected_shape(clinical_csv: bytes) -> None:
    rows = list(csv.DictReader(io.StringIO(clinical_csv.decode("utf-8"))))

    assert len(rows) == 5_200
    assert len(rows[0]) == 18
    assert hashlib.sha256(clinical_csv).hexdigest() == (
        "7094f2c4be15e76e795c42fab93f1c53ac35df6b322289861ed4b21784832c2d"
    )


@pytest.mark.parametrize(
    ("finding_id", "expected_records"),
    [
        ("DUP-001", 43),
        ("CAT-002", 61),
        ("FMT-003", 72),
        ("SEM-004", 183),
        ("SEM-004-CONFLICT", 1),
        ("AMB-005", 8),
        ("MISS-006", 27),
        ("PHI-007", 3),
    ],
)
def test_golden_finding_counts(
    clinical_csv: bytes,
    clinical_policy: dict[str, object],
    finding_id: str,
    expected_records: int,
) -> None:
    report = analyze_csv(
        clinical_csv,
        clinical_policy,
        synthetic=True,
        fixture_version="clinical-nlp-1.0.0",
    )
    findings = {finding.finding_id: finding for finding in report.findings}

    assert findings[finding_id].affected_record_count == expected_records


def test_report_is_blocked_and_sensitive_values_are_redacted(
    clinical_csv: bytes,
    clinical_policy: dict[str, object],
) -> None:
    report = analyze_csv(
        clinical_csv,
        clinical_policy,
        synthetic=True,
        fixture_version="clinical-nlp-1.0.0",
    )
    payload = canonical_json(report.model_dump(mode="json"))

    assert report.release_status is ReleaseStatus.BLOCKED
    assert report.profile.record_count == 5_200
    assert report.profile.column_count == 18
    assert "demo.patient@example.test" not in payload
    assert "+1 202 555 0182" not in payload
    assert "Example Person" not in payload


def test_csv_without_policy_is_observational_only() -> None:
    source = b"id,value\n1,Alpha\n2,Alpha\n"

    report = analyze_csv(source)

    assert report.release_status is ReleaseStatus.NOT_EVALUATED
    assert "observational only" in report.warnings[0]
