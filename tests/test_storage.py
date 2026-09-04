from __future__ import annotations

import json
from pathlib import Path

import pytest
from datapilot.contracts.models import (
    AICallRecord,
    AIStatus,
    AITask,
    ContractSource,
    EventStatus,
    GroundingResult,
    HumanDecision,
    Lifecycle,
    ProviderName,
    RedactionSummary,
    ReleaseStatus,
)
from datapilot.storage import RunStore, StorageError


def _record(run_id: str, call_id: str) -> AICallRecord:
    return AICallRecord(
        call_id=call_id,
        run_id=run_id,
        task=AITask.SEMANTIC,
        provider=ProviderName.DETERMINISTIC,
        model_requested="claude-opus-5",
        model_served=None,
        prompt_version="sem-1",
        input_hash="a" * 64,
        output_hash=None,
        input_tokens=None,
        output_tokens=None,
        cache_read_tokens=None,
        latency_ms=3,
        status=AIStatus.FALLBACK_DETERMINISTIC,
        grounding=GroundingResult(valid=True, reason_codes=[]),
        redaction=RedactionSummary(
            rows_sent=0, columns_withheld=["note"], values_sent=4, chars_sent=20
        ),
        request_id=None,
        created_at="2026-09-04T00:00:00.000Z",
    )


@pytest.fixture
def store(tmp_path: Path) -> RunStore:
    return RunStore(tmp_path / "runs")


def test_create_writes_meta_source_and_contract(store: RunStore) -> None:
    summary = store.create("run-1", b"a,b\n1,2\n", "orders.csv", "id: x\nversion: '1'\n", "sample")
    assert summary.run_id == "run-1"
    assert summary.lifecycle is Lifecycle.QUEUED
    assert summary.run_revision == 1
    assert summary.record_count is None
    assert summary.created_at.endswith("Z")
    assert store.exists("run-1")
    assert store.read_source("run-1") == b"a,b\n1,2\n"
    assert store.read_contract_yaml("run-1") == "id: x\nversion: '1'\n"
    meta = json.loads((store.run_dir("run-1") / "meta.json").read_text(encoding="utf-8"))
    assert set(meta) == {
        "run_id",
        "created_at",
        "source_name",
        "sample_id",
        "lifecycle",
        "run_revision",
        "record_count",
        "column_count",
        "release_status",
        "contract_source",
        "error",
    }
    assert meta["sample_id"] == "sample"
    with pytest.raises(StorageError) as info:
        store.create("run-1", b"", "again.csv", None, None)
    assert info.value.code == "RUN_EXISTS"


def test_create_without_contract(store: RunStore) -> None:
    store.create("run-2", b"a\n1\n", "x.csv", None, None)
    assert store.read_contract_yaml("run-2") is None
    assert not store.has("run-2", "contract.yaml")
    store.write_contract_yaml("run-2", "id: y\nversion: '1'\n")
    assert store.read_contract_yaml("run-2") == "id: y\nversion: '1'\n"


def test_update_meta_and_summary(store: RunStore) -> None:
    store.create("run-3", b"a\n", "x.csv", None, None)
    meta = store.update_meta(
        "run-3",
        lifecycle=Lifecycle.REVIEW_REQUIRED,
        record_count=10,
        column_count=2,
        release_status=ReleaseStatus.BLOCKED,
        contract_source=ContractSource.SAMPLE,
        error={"code": "X", "message_zh": "错", "message_en": "err", "retryable": False,
               "correlation_id": "c"},
    )
    assert meta["lifecycle"] == "REVIEW_REQUIRED"
    summary = store.summary("run-3")
    assert summary.lifecycle is Lifecycle.REVIEW_REQUIRED
    assert summary.release_status is ReleaseStatus.BLOCKED
    assert summary.contract_source is ContractSource.SAMPLE
    assert summary.record_count == 10
    assert store.read_meta("run-3")["error"]["code"] == "X"
    with pytest.raises(StorageError) as info:
        store.update_meta("run-3", bogus=1)
    assert info.value.code == "META_FIELD_INVALID"


def test_json_artifacts_accept_models_and_dicts(store: RunStore) -> None:
    store.create("run-4", b"a\n", "x.csv", None, None)
    # plain-string outcome is accepted from JSON bodies (Field(strict=False))
    decision = HumanDecision.model_validate(
        {"finding_id": "DUP-EXACT", "outcome": "QUARANTINE", "run_revision": 1}
    )
    store.write_json("run-4", "decisions.json", {"DUP-EXACT": decision})
    loaded = store.read_json("run-4", "decisions.json")
    assert loaded == {
        "DUP-EXACT": {
            "finding_id": "DUP-EXACT",
            "outcome": "QUARANTINE",
            "reason": None,
            "run_revision": 1,
        }
    }
    store.write_json("run-4", "brief.json", decision)
    assert store.read_model("run-4", "brief.json", HumanDecision) == decision
    assert store.read_model("run-4", "missing.json", HumanDecision) is None
    with pytest.raises(StorageError) as info:
        store.read_json("run-4", "missing.json")
    assert info.value.code == "ARTIFACT_NOT_FOUND"
    with pytest.raises(StorageError) as info:
        store.write_json("run-4", "../escape.json", {})
    assert info.value.code == "ARTIFACT_NAME_INVALID"
    with pytest.raises(StorageError) as info:
        store.write_json("nope", "report.json", {})
    assert info.value.code == "RUN_NOT_FOUND"
    with pytest.raises(StorageError) as info:
        store.run_dir("../x")
    assert info.value.code == "RUN_ID_INVALID"
    assert store.remove("run-4", "brief.json") is True
    assert store.remove("run-4", "brief.json") is False
    with pytest.raises(StorageError):
        store.remove("run-4", "source.csv")


@pytest.mark.parametrize("name", ["source.csv", "meta.json"])
@pytest.mark.parametrize("writer", ["write_bytes", "write_json"])
def test_generic_writers_cannot_overwrite_protected_artifacts(
    store: RunStore, name: str, writer: str
) -> None:
    store.create("protected", b"a\n1\n", "x.csv", None, None)
    before = store.path("protected", name).read_bytes()

    with pytest.raises(StorageError) as info:
        if writer == "write_bytes":
            store.write_bytes("protected", name, b"tampered")
        else:
            store.write_json("protected", name, {"tampered": True})

    assert info.value.code == "ARTIFACT_PROTECTED"
    assert store.path("protected", name).read_bytes() == before


def test_events_are_monotonic_and_survive_reopen(store: RunStore, tmp_path: Path) -> None:
    store.create("run-5", b"a\n", "x.csv", None, None)
    first = store.append_event("run-5", "INGESTING", EventStatus.STARTED, "开始", "start")
    second = store.append_event(
        "run-5",
        "INGESTING",
        EventStatus.COMPLETED,
        "完成",
        "done",
        elapsed_ms=12,
        detail={"rows": 5, "lifecycle": Lifecycle.RUNNING},
    )
    assert (first.seq, second.seq) == (1, 2)
    assert second.elapsed_ms == 12
    assert second.detail == {"rows": 5, "lifecycle": "RUNNING"}
    assert first.ts <= second.ts

    reopened = RunStore(tmp_path / "runs")
    third = reopened.append_event("run-5", "PROFILING", EventStatus.INFO, "信息", "info")
    assert third.seq == 3
    events = reopened.read_events("run-5")
    assert [event.seq for event in events] == [1, 2, 3]
    assert events[1].status is EventStatus.COMPLETED
    assert [event.seq for event in reopened.read_events("run-5", after_seq=2)] == [3]
    assert reopened.read_events("run-5", after_seq=99) == []
    lines = (store.run_dir("run-5") / "events.jsonl").read_text(encoding="utf-8").splitlines()
    assert len(lines) == 3
    assert all(json.loads(line)["message_zh"] for line in lines)


def test_events_require_existing_run(store: RunStore) -> None:
    with pytest.raises(StorageError) as info:
        store.append_event("ghost", "INGESTING", EventStatus.STARTED, "x", "x")
    assert info.value.code == "RUN_NOT_FOUND"
    assert store.read_events("ghost") == []


def test_ledger_append_and_read(store: RunStore) -> None:
    store.create("run-6", b"a\n", "x.csv", None, None)
    assert store.read_ledger("run-6") == []
    store.append_ledger("run-6", _record("run-6", "call-1"))
    store.append_ledger("run-6", _record("run-6", "call-2"))
    ledger = store.read_ledger("run-6")
    assert [record.call_id for record in ledger] == ["call-1", "call-2"]
    assert ledger[0].provider is ProviderName.DETERMINISTIC
    assert ledger[0].redaction.columns_withheld == ["note"]
    assert store.ledger_count("run-6") == 2


def test_list_runs_newest_first_and_skips_corrupt(store: RunStore) -> None:
    store.create("run-a", b"a\n", "a.csv", None, None)
    store.create("run-b", b"a\n", "b.csv", None, None)
    store.update_meta("run-a", created_at="2026-01-01T00:00:00.000Z")
    store.update_meta("run-b", created_at="2026-02-01T00:00:00.000Z")
    broken = store.root / "run-c"
    broken.mkdir()
    (broken / "meta.json").write_text("{not json", encoding="utf-8")
    (store.root / "stray.txt").write_text("ignored", encoding="utf-8")
    listed = store.list_runs()
    assert [item.run_id for item in listed] == ["run-b", "run-a"]
    assert listed[0].source_name == "b.csv"


def test_delete_removes_directory(store: RunStore) -> None:
    store.create("run-7", b"a\n", "x.csv", None, None)
    store.append_event("run-7", "INGESTING", EventStatus.STARTED, "x", "x")
    assert store.delete("run-7") is True
    assert not store.exists("run-7")
    assert not store.run_dir("run-7").exists()
    assert store.delete("run-7") is False
    assert store.list_runs() == []
    store.create("run-7", b"b\n", "y.csv", None, None)
    assert store.append_event("run-7", "INGESTING", EventStatus.STARTED, "x", "x").seq == 1
