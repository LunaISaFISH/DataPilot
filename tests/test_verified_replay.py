"""Privacy and conservation gates for the static UCI booth replay."""

from __future__ import annotations

import hashlib
import json
from collections import Counter
from pathlib import Path
from typing import Any

ROOT = Path(__file__).parents[1]
SNAPSHOT = json.loads(
    (ROOT / "lib/data/uci-online-retail-replay.json").read_text(encoding="utf-8")
)


def _nested_keys(value: Any) -> set[str]:
    if isinstance(value, dict):
        return set(value) | {key for child in value.values() for key in _nested_keys(child)}
    if isinstance(value, list):
        return {key for child in value for key in _nested_keys(child)}
    return set()


def test_verified_replay_is_pinned_to_the_real_uci_source() -> None:
    source = ROOT / "fixtures/uci_online_retail/online_retail_2010_12.csv"
    assert SNAPSHOT["presentation"] == {
        "live": False,
        "mode": "offline-replay",
        "notice_en": "Verified offline replay; not a live run",
        "notice_zh": "已验证的离线回放，不是实时运行",
    }
    assert SNAPSHOT["source"]["synthetic"] is False
    assert SNAPSHOT["source"]["record_count"] == 42_481
    assert hashlib.sha256(source.read_bytes()).hexdigest() == SNAPSHOT["source"]["sha256"]


def test_verified_replay_conserves_findings_and_release_rows() -> None:
    dispositions = SNAPSHOT["governance"]["finding_dispositions"]
    release = SNAPSHOT["release"]
    reconciled_rows = sum(
        release[name]
        for name in ("eligible_record_count", "quarantined_record_count", "excluded_record_count")
    )
    assert len(SNAPSHOT["findings"]) == len(dispositions) == 7
    assert Counter(dispositions.values()) == Counter(release["finding_outcome_counts"])
    assert reconciled_rows == SNAPSHOT["source"]["record_count"]


def test_verified_replay_contains_only_grounded_aggregate_ai_evidence() -> None:
    calls = SNAPSHOT["ai"]["calls"]
    forbidden = {"rows", "record_uids", "request_payload", "response_payload", "distinct_examples"}
    assert len(calls) == 1
    assert calls[0]["redaction"]["rows_sent"] == 0
    assert calls[0]["grounding"]["valid"] is True
    assert not (_nested_keys(SNAPSHOT) & forbidden)


def test_verified_replay_passes_both_validation_layers() -> None:
    summary = SNAPSHOT["release"]["validation_summary"]
    assert summary == {"failed": 0, "passed": 14}
    assert all(check["passed"] for check in SNAPSHOT["validations"])
    assert SNAPSHOT["verification"]["ok"] is True
    assert all(check["passed"] for check in SNAPSHOT["verification"]["checks"])
