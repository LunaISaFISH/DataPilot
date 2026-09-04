"""Pipeline stage/event tests (spec §6). Inline execution, replay AI provider."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from datapilot.ai import get_runtime
from datapilot.contracts.models import ContractSource, EventStatus, Lifecycle, RunReport
from datapilot.pipeline import (
    STAGE_BRIEF_DRAFTING,
    STAGE_CONTRACT_DRAFTING,
    STAGE_DETECTING,
    STAGE_INGESTING,
    STAGE_OBSERVATIONAL_READY,
    STAGE_PROFILING,
    STAGE_REVIEW_REQUIRED,
    STAGE_SEMANTIC_ANALYSIS,
    STAGE_SENSITIVE_PREFLIGHT,
    Pipeline,
)
from datapilot.samples import get_sample, sample_contract_text
from datapilot.storage import RunStore

SMALL_CSV = b"id,value\n1,Alpha\n2,Beta\n3,Alpha\n"


@pytest.fixture
def store(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> RunStore:
    monkeypatch.setenv("DATAPILOT_AI_MODE", "replay")
    monkeypatch.setenv("DATAPILOT_DATA_DIR", str(tmp_path))
    return RunStore(tmp_path / "runs")


@pytest.fixture
def pipeline(store: RunStore) -> Pipeline:
    return Pipeline(store, get_runtime(store), sync=True)


def _stages(store: RunStore, run_id: str) -> list[tuple[str, str]]:
    return [(event.stage, event.status.value) for event in store.read_events(run_id)]


def test_analysis_with_contract_emits_every_stage(store: RunStore, pipeline: Pipeline) -> None:
    sample = get_sample("clinical_nlp")
    contract_text = sample_contract_text("clinical_nlp")
    store.create("run-1", sample.generate(), "clinical.csv", contract_text, "clinical_nlp")
    store.update_meta("run-1", contract_source=ContractSource.SAMPLE.value)

    assert pipeline.submit_analysis("run-1") is True

    meta = store.read_meta("run-1")
    assert meta["lifecycle"] == Lifecycle.REVIEW_REQUIRED.value
    assert meta["record_count"] == 5_200
    assert meta["release_status"] == "BLOCKED"
    assert meta["contract_source"] == "sample"
    assert meta["error"] is None
    assert pipeline.is_active("run-1") is False

    stages = _stages(store, "run-1")
    expected_order = [
        (STAGE_INGESTING, "STARTED"),
        (STAGE_INGESTING, "COMPLETED"),
        (STAGE_PROFILING, "STARTED"),
        (STAGE_PROFILING, "COMPLETED"),
        (STAGE_DETECTING, "STARTED"),
        (STAGE_DETECTING, "COMPLETED"),
        (STAGE_SENSITIVE_PREFLIGHT, "STARTED"),
        (STAGE_SENSITIVE_PREFLIGHT, "COMPLETED"),
        (STAGE_SEMANTIC_ANALYSIS, "STARTED"),
        (STAGE_SEMANTIC_ANALYSIS, "COMPLETED"),
        (STAGE_REVIEW_REQUIRED, "COMPLETED"),
    ]
    assert stages == expected_order

    events = store.read_events("run-1")
    assert [event.seq for event in events] == list(range(1, len(events) + 1))
    completed = [e for e in events if e.status is EventStatus.COMPLETED]
    ingest = next(e for e in completed if e.stage == STAGE_INGESTING)
    assert ingest.detail["rows"] == 5_200
    assert ingest.detail["encoding"]
    semantic = next(e for e in completed if e.stage == STAGE_SEMANTIC_ANALYSIS)
    assert set(semantic.detail) >= {"sem_columns", "provider", "model"}
    assert semantic.detail["provider"] in ("verified-replay", "deterministic", "anthropic")
    for event in events:
        assert event.message_zh and event.message_en

    report = store.read_model("run-1", "report.json", RunReport)
    assert report is not None
    assert report.contract.source is ContractSource.SAMPLE
    assert report.run_revision == 1


def test_analysis_without_contract_is_observational(store: RunStore, pipeline: Pipeline) -> None:
    store.create("run-2", SMALL_CSV, "small.csv", None, None)
    store.update_meta("run-2", contract_source=ContractSource.BASELINE.value)

    pipeline.submit_analysis("run-2")

    meta = store.read_meta("run-2")
    assert meta["lifecycle"] == Lifecycle.OBSERVATIONAL.value
    assert meta["release_status"] == "NOT_EVALUATED"
    assert meta["record_count"] == 3
    assert meta["column_count"] == 2
    assert _stages(store, "run-2")[-1] == (STAGE_OBSERVATIONAL_READY, "COMPLETED")
    report = store.read_model("run-2", "report.json", RunReport)
    assert report is not None
    assert report.contract.source is ContractSource.BASELINE


def test_invalid_csv_fails_closed(store: RunStore, pipeline: Pipeline) -> None:
    store.create("run-3", b"a,a\n1,2\n", "dup.csv", None, None)

    pipeline.submit_analysis("run-3")

    meta = store.read_meta("run-3")
    assert meta["lifecycle"] == Lifecycle.FAILED.value
    assert isinstance(meta["error"], dict)
    assert meta["error"]["code"]
    assert meta["error"]["message_zh"] and meta["error"]["message_en"]
    stages = _stages(store, "run-3")
    assert stages[0] == (STAGE_INGESTING, "STARTED")
    assert stages[-1][1] == "FAILED"
    assert pipeline.is_active("run-3") is False
    assert not store.has("run-3", "report.json")


def test_invalid_contract_fails_closed(store: RunStore, pipeline: Pipeline) -> None:
    store.create("run-4", SMALL_CSV, "small.csv", "id: [broken", None)

    pipeline.submit_analysis("run-4")

    meta = store.read_meta("run-4")
    assert meta["lifecycle"] == Lifecycle.FAILED.value
    assert meta["error"]["code"].startswith("CONTRACT_")


def test_same_job_is_not_submitted_twice(store: RunStore) -> None:
    class _BlockingPipeline(Pipeline):
        def run_analysis(self, run_id: str) -> None:
            assert self.is_job_active(run_id, "analysis")
            assert self.submit_analysis(run_id) is False

    store.create("run-5", SMALL_CSV, "small.csv", None, None)
    pipeline = _BlockingPipeline(store, get_runtime(store), sync=True)

    assert pipeline.submit_analysis("run-5") is True
    assert pipeline.active_jobs("run-5") == set()


def test_contract_draft_job_writes_result_and_events(store: RunStore, pipeline: Pipeline) -> None:
    store.create("run-6", SMALL_CSV, "small.csv", None, None)
    pipeline.submit_analysis("run-6")

    pipeline.submit_contract_draft("run-6")

    draft = json.loads((store.run_dir("run-6") / "contract-draft.json").read_text("utf-8"))
    assert draft["status"] in ("ready", "failed")
    stages = _stages(store, "run-6")
    assert (STAGE_CONTRACT_DRAFTING, "STARTED") in stages
    assert stages[-1][0] == STAGE_CONTRACT_DRAFTING
    assert store.read_meta("run-6")["lifecycle"] == Lifecycle.OBSERVATIONAL.value


def test_brief_job_without_execution_fails_without_breaking_lifecycle(
    store: RunStore, pipeline: Pipeline
) -> None:
    store.create("run-7", SMALL_CSV, "small.csv", None, None)
    pipeline.submit_analysis("run-7")

    pipeline.submit_brief("run-7")

    brief = json.loads((store.run_dir("run-7") / "brief.json").read_text("utf-8"))
    assert brief["status"] == "failed"
    assert brief["summary_zh"] and brief["summary_en"]
    stages = _stages(store, "run-7")
    assert stages[-1] == (STAGE_BRIEF_DRAFTING, "FAILED")
    assert store.read_meta("run-7")["lifecycle"] == Lifecycle.OBSERVATIONAL.value
