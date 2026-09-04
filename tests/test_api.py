"""HTTP API v2 flow tests (spec §7, §10).

All tests run the pipeline inline (``DATAPILOT_SYNC_PIPELINE=1``) with the replay AI provider
against an isolated data directory per test.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from datapilot.api.main import Settings, create_app
from datapilot.contracts.models import RunReport
from datapilot.governance import demo_decisions
from fastapi.testclient import TestClient

SMALL_CSV = (
    b"id,value,when\n"
    b"1,Alpha,2024-01-01\n"
    b"2,Beta,2024-01-02\n"
    b"3,Gamma,2024-01-03\n"
    b"4,Alpha,2024-01-04\n"
)

SMALL_CONTRACT = """
id: small-upload
version: 1.0.0
title_zh: 上传测试契约
title_en: Upload test contract
fields:
  id: { required: true, unique: true }
  value:
    canonical:
      Alpha: [alpha, ALPHA]
    allowed: [Alpha, Beta, Gamma]
  when: { type: date, format: "%Y-%m-%d" }
auto_authorization:
  exact_duplicate_exclusion: true
  category_normalization: true
  date_standardization: true
"""


@pytest.fixture
def data_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setenv("DATAPILOT_AI_MODE", "replay")
    monkeypatch.setenv("DATAPILOT_SYNC_PIPELINE", "1")
    monkeypatch.setenv("DATAPILOT_DATA_DIR", str(tmp_path))
    monkeypatch.delenv("DATAPILOT_API_TOKEN", raising=False)
    return tmp_path


@pytest.fixture
def settings(data_dir: Path) -> Settings:
    return Settings(data_dir=data_dir, sync_pipeline=True)


@pytest.fixture
def client(settings: Settings) -> Iterator[TestClient]:
    with TestClient(create_app(settings)) as test_client:
        yield test_client


def _create_sample_run(client: TestClient, sample_id: str = "clinical_nlp") -> str:
    created = client.post("/v1/runs/from-sample", json={"sample_id": sample_id})
    assert created.status_code == 202, created.text
    body = created.json()
    assert body["run_id"]
    assert body["run_revision"] == 1
    return str(body["run_id"])


def _decide_all(client: TestClient, run_id: str) -> dict[str, object]:
    detail = client.get(f"/v1/runs/{run_id}").json()
    report = RunReport.model_validate_json(json.dumps(detail["report"]))
    decisions = [
        {"finding_id": d.finding_id, "outcome": d.outcome.value, "reason": d.reason}
        for d in demo_decisions(report)
    ]
    response = client.put(f"/v1/runs/{run_id}/decisions", json={"decisions": decisions})
    assert response.status_code == 200, response.text
    return dict(response.json())


# --------------------------------------------------------------------------------------
# health, samples, error envelope
# --------------------------------------------------------------------------------------


def test_health_reports_engine_ai_and_samples(client: TestClient) -> None:
    response = client.get("/health")

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["engine_version"]
    assert body["ai"]["mode"] == "replay"
    assert body["ai"]["provider"] == "verified-replay"
    assert body["samples"] >= 1
    assert body["data_dir_writable"] is True
    assert response.headers["X-Correlation-Id"]
    assert response.headers["Server-Timing"].startswith("total;dur=")


def test_samples_lists_bundled_datasets(client: TestClient) -> None:
    response = client.get("/v1/samples")

    assert response.status_code == 200
    ids = {item["id"] for item in response.json()}
    assert "clinical_nlp" in ids
    clinical = next(item for item in response.json() if item["id"] == "clinical_nlp")
    assert clinical["has_contract"] is True
    assert clinical["title_zh"] and clinical["title_en"]


def test_unknown_run_returns_structured_error(client: TestClient) -> None:
    response = client.get("/v1/runs/does-not-exist")

    assert response.status_code == 404
    error = response.json()["error"]
    assert error["code"] == "RUN_NOT_FOUND"
    assert error["message_zh"] and error["message_en"]
    assert error["retryable"] is False
    assert error["correlation_id"] == response.headers["X-Correlation-Id"]


def test_unknown_sample_is_404(client: TestClient) -> None:
    response = client.post("/v1/runs/from-sample", json={"sample_id": "nope"})

    assert response.status_code == 404
    assert response.json()["error"]["code"] == "SAMPLE_NOT_FOUND"


def test_request_validation_error_uses_envelope(client: TestClient) -> None:
    response = client.post("/v1/runs/from-sample", json={"sample": "clinical_nlp"})

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "REQUEST_INVALID"


# --------------------------------------------------------------------------------------
# full flow on the clinical sample
# --------------------------------------------------------------------------------------


def test_clinical_sample_full_flow(client: TestClient) -> None:
    run_id = _create_sample_run(client)

    detail = client.get(f"/v1/runs/{run_id}")
    assert detail.status_code == 200
    body = detail.json()
    assert body["lifecycle"] == "REVIEW_REQUIRED"
    assert body["report"]["profile"]["record_count"] == 5_200
    assert body["report"]["release_status"] == "BLOCKED"
    assert body["report"]["contract"]["source"] == "sample"
    assert body["contract"]["source"] == "sample"
    assert body["contract"]["hash"] == body["report"]["contract"]["hash"]
    assert body["decisions"] == {}
    assert body["dry_run"] is None
    assert body["execution"] is None

    # dry run before decisions is refused with the unresolved list
    blocked = client.post(f"/v1/runs/{run_id}/dry-run")
    assert blocked.status_code == 409
    assert blocked.json()["error"]["code"] == "UNRESOLVED_FINDINGS"
    assert blocked.json()["error"]["observed"]

    decided = _decide_all(client, run_id)
    assert decided["unresolved"] == []
    assert decided["decisions"]

    dry = client.post(f"/v1/runs/{run_id}/dry-run")
    assert dry.status_code == 200, dry.text
    dry_run = dry.json()["dry_run"]
    preview = dry.json()["preview"]
    assert dry_run["status"] == "NOT_APPLIED"
    assert dry_run["actions"]
    assert "changes" in preview and "totals" in preview
    assert client.get(f"/v1/runs/{run_id}").json()["lifecycle"] == "DRY_RUN_READY"

    stale = client.post(
        f"/v1/runs/{run_id}/apply",
        json={"run_revision": 1, "approved_action_set_hash": "0" * 64},
        headers={"Idempotency-Key": "stale-key-0001"},
    )
    assert stale.status_code == 409
    assert stale.json()["error"]["code"] == "STALE_DRY_RUN"
    assert stale.json()["error"]["expected"] == dry_run["approved_action_set_hash"]

    applied = client.post(
        f"/v1/runs/{run_id}/apply",
        json={"run_revision": 1, "approved_action_set_hash": dry_run["approved_action_set_hash"]},
        headers={"Idempotency-Key": "apply-key-0001"},
    )
    assert applied.status_code == 200, applied.text
    manifest = applied.json()["release_manifest"]
    assert manifest["release_status"] in ("CONDITIONAL_PASS", "PASS")
    assert all(v["passed"] for v in applied.json()["validations"])
    assert manifest["validation_summary"]["failed"] == 0
    assert "X-Idempotent-Replay" not in applied.headers

    replayed = client.post(
        f"/v1/runs/{run_id}/apply",
        json={
            "run_revision": 1,
            "approved_action_set_hash": dry_run["approved_action_set_hash"],
            "idempotency_key": "apply-key-0001",
        },
    )
    assert replayed.status_code == 200
    assert replayed.headers["X-Idempotent-Replay"] == "true"
    assert replayed.json() == applied.json()

    other_key = client.post(
        f"/v1/runs/{run_id}/apply",
        json={"run_revision": 1, "approved_action_set_hash": dry_run["approved_action_set_hash"]},
        headers={"Idempotency-Key": "apply-key-0002"},
    )
    assert other_key.status_code == 409
    assert other_key.json()["error"]["code"] == "RUN_APPLIED"

    final = client.get(f"/v1/runs/{run_id}").json()
    assert final["lifecycle"] == "APPLIED"
    assert final["execution"]["release_manifest"] == manifest

    artifacts = client.get(f"/v1/runs/{run_id}/artifacts")
    assert artifacts.status_code == 200
    names = {item["name"]: item for item in artifacts.json()}
    for expected in ("source.csv", "report.json", "release.csv", "release-manifest.json"):
        assert expected in names
        assert len(names[expected]["sha256"]) == 64
    assert names["release.csv"]["role"] == "release"

    release = client.get(f"/v1/runs/{run_id}/artifacts/release.csv")
    assert release.status_code == 200
    assert release.headers["content-type"].startswith("text/csv")
    import hashlib

    assert hashlib.sha256(release.content).hexdigest() == manifest["release_artifact_hash"]

    bundle = client.get(f"/v1/runs/{run_id}/artifacts/audit-bundle.json")
    assert bundle.status_code == 200
    audit = bundle.json()
    assert audit["report"]["profile"]["record_count"] == 5_200
    assert audit["release_manifest"]["release_artifact_hash"] == manifest["release_artifact_hash"]
    assert audit["decisions"]
    assert audit["dry_run"]["approved_action_set_hash"] == dry_run["approved_action_set_hash"]

    ledger = client.get(f"/v1/runs/{run_id}/ai-ledger")
    assert ledger.status_code == 200
    assert isinstance(ledger.json(), list)

    brief = client.get(f"/v1/runs/{run_id}/brief")
    assert brief.status_code == 200
    assert brief.json()["status"] in ("ready", "failed")
    assert brief.json()["summary_zh"] is not None

    tamper = client.post(f"/v1/runs/{run_id}/tamper-test")
    assert tamper.status_code == 200
    assert tamper.json()["written"] is False
    assert tamper.json()["tampered_source_hash"] != tamper.json()["expected_source_hash"]
    execution = tamper.json()["execution"]
    if execution is not None:
        source_check = next(
            v for v in execution["validations"] if v["check_id"] == "SOURCE_IMMUTABLE"
        )
        assert source_check["passed"] is False
        assert execution["release_manifest"]["release_status"] == "BLOCKED"
    else:
        assert tamper.json()["refused"]["code"]

    # decisions are frozen once applied
    frozen = client.put(
        f"/v1/runs/{run_id}/decisions",
        json={"decisions": []},
    )
    assert frozen.status_code == 409
    assert frozen.json()["error"]["code"] == "RUN_APPLIED"


def test_decisions_validate_finding_ids_and_outcomes(client: TestClient) -> None:
    run_id = _create_sample_run(client)
    report = RunReport.model_validate_json(
        json.dumps(client.get(f"/v1/runs/{run_id}").json()["report"])
    )

    unknown = client.put(
        f"/v1/runs/{run_id}/decisions",
        json={"decisions": [{"finding_id": "NOPE-1", "outcome": "QUARANTINE"}]},
    )
    assert unknown.status_code == 422
    assert unknown.json()["error"]["code"] == "FINDING_NOT_FOUND"
    assert unknown.json()["error"]["finding_id"] == "NOPE-1"

    quarantine_only = next(
        f for f in report.findings if f.authorization_mode.value == "QUARANTINE_ONLY"
    )
    disallowed = client.put(
        f"/v1/runs/{run_id}/decisions",
        json={
            "decisions": [{"finding_id": quarantine_only.finding_id, "outcome": "APPROVE_PROPOSAL"}]
        },
    )
    assert disallowed.status_code == 422
    error = disallowed.json()["error"]
    assert error["code"] == "OUTCOME_NOT_ALLOWED"
    assert error["finding_id"] == quarantine_only.finding_id
    assert "QUARANTINE" in error["expected"]

    allowed = client.put(
        f"/v1/runs/{run_id}/decisions",
        json={"decisions": [{"finding_id": quarantine_only.finding_id, "outcome": "QUARANTINE"}]},
    )
    assert allowed.status_code == 200
    assert quarantine_only.finding_id in allowed.json()["decisions"]
    assert quarantine_only.finding_id not in allowed.json()["unresolved"]


def test_finding_records_are_masked_for_sensitive_columns(client: TestClient) -> None:
    run_id = _create_sample_run(client)
    report = RunReport.model_validate_json(
        json.dumps(client.get(f"/v1/runs/{run_id}").json()["report"])
    )
    phi = next((f for f in report.findings if f.finding_id.startswith("PHI-")), None)
    assert phi is not None

    response = client.get(f"/v1/runs/{run_id}/findings/{phi.finding_id}/records?limit=5")

    assert response.status_code == 200
    body = response.json()
    assert phi.column in body["masked_columns"]
    assert 0 < len(body["rows"]) <= 5
    for row in body["rows"]:
        assert row["cells"][phi.column] in (None, "••••")
        assert row["record_uid"] in phi.record_uids

    missing = client.get(f"/v1/runs/{run_id}/findings/NOPE-1/records")
    assert missing.status_code == 404
    assert missing.json()["error"]["code"] == "FINDING_NOT_FOUND"


# --------------------------------------------------------------------------------------
# observational upload + contract replacement
# --------------------------------------------------------------------------------------


def test_upload_without_contract_is_observational(client: TestClient) -> None:
    created = client.post("/v1/runs", files={"file": ("sample.csv", SMALL_CSV, "text/csv")})
    assert created.status_code == 202, created.text
    run_id = created.json()["run_id"]

    detail = client.get(f"/v1/runs/{run_id}").json()
    assert detail["lifecycle"] == "OBSERVATIONAL"
    assert detail["source_name"] == "sample.csv"
    assert detail["report"]["release_status"] == "NOT_EVALUATED"
    assert detail["report"]["contract"]["source"] == "baseline"
    assert detail["report"]["profile"]["record_count"] == 4

    refused = client.post(f"/v1/runs/{run_id}/dry-run")
    assert refused.status_code == 409
    assert refused.json()["error"]["code"] == "NOT_EVALUATED"

    contract = client.get(f"/v1/runs/{run_id}/contract").json()
    assert contract["source"] == "baseline"
    assert contract["parsed"]["id"] == "baseline-observational"

    listed = client.get("/v1/runs").json()
    assert [item["run_id"] for item in listed] == [run_id]
    assert listed[0]["lifecycle"] == "OBSERVATIONAL"
    assert listed[0]["record_count"] == 4


def test_empty_upload_is_rejected(client: TestClient) -> None:
    response = client.post("/v1/runs", files={"file": ("empty.csv", b"", "text/csv")})

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "CSV_EMPTY"


def test_invalid_contract_upload_is_422(client: TestClient) -> None:
    response = client.post(
        "/v1/runs",
        files={
            "file": ("sample.csv", SMALL_CSV, "text/csv"),
            "policy": ("contract.yaml", b"id: [unclosed", "application/yaml"),
        },
    )

    assert response.status_code == 422
    assert response.json()["error"]["code"].startswith("CONTRACT_")


def test_put_contract_reanalyses_and_bumps_revision(client: TestClient) -> None:
    created = client.post("/v1/runs", files={"file": ("sample.csv", SMALL_CSV, "text/csv")})
    run_id = created.json()["run_id"]

    invalid = client.put(f"/v1/runs/{run_id}/contract", json={"yaml": "fields: [oops"})
    assert invalid.status_code == 422
    assert invalid.json()["error"]["code"].startswith("CONTRACT_")

    replaced = client.put(f"/v1/runs/{run_id}/contract", json={"yaml": SMALL_CONTRACT})
    assert replaced.status_code == 202, replaced.text
    assert replaced.json()["run_revision"] == 2

    detail = client.get(f"/v1/runs/{run_id}").json()
    assert detail["run_revision"] == 2
    assert detail["lifecycle"] == "REVIEW_REQUIRED"
    assert detail["report"]["run_revision"] == 2
    assert detail["report"]["contract"]["id"] == "small-upload"
    assert detail["report"]["contract"]["source"] == "uploaded"
    assert detail["report"]["release_status"] != "NOT_EVALUATED"
    assert detail["decisions"] == {}
    assert detail["dry_run"] is None

    view = client.get(f"/v1/runs/{run_id}/contract").json()
    assert view["parsed"]["id"] == "small-upload"
    assert view["source"] == "uploaded"
    assert view["hash"] == detail["report"]["contract"]["hash"]

    stages = [event["stage"] for event in _read_events(client, run_id)]
    assert "CONTRACT_REPLACED" in stages
    assert stages.count("INGESTING") == 4  # two analyses, STARTED + COMPLETED each


def _read_events(client: TestClient, run_id: str, after: int = 0) -> list[dict[str, object]]:
    events: list[dict[str, object]] = []
    with client.stream("GET", f"/v1/runs/{run_id}/events", params={"after": after}) as stream:
        assert stream.status_code == 200
        assert stream.headers["content-type"].startswith("text/event-stream")
        assert stream.headers["cache-control"] == "no-cache"
        assert stream.headers["x-accel-buffering"] == "no"
        for line in stream.iter_lines():
            if line.startswith("data: "):
                events.append(json.loads(line[len("data: ") :]))
    return events


# --------------------------------------------------------------------------------------
# events (SSE)
# --------------------------------------------------------------------------------------


def test_events_stream_replays_persisted_events(client: TestClient) -> None:
    run_id = _create_sample_run(client)

    events = _read_events(client, run_id, after=1)

    assert events
    assert events[0]["seq"] == 2
    seqs = [int(str(event["seq"])) for event in events]
    assert seqs == sorted(seqs)
    stages = [event["stage"] for event in events]
    assert stages[-1] == "REVIEW_REQUIRED"
    for stage in ("PROFILING", "DETECTING", "SENSITIVE_PREFLIGHT", "SEMANTIC_ANALYSIS"):
        assert stage in stages
    semantic = next(
        e for e in events if e["stage"] == "SEMANTIC_ANALYSIS" and e["status"] == "COMPLETED"
    )
    detail = semantic["detail"]
    assert isinstance(detail, dict)
    assert "sem_columns" in detail and "provider" in detail and "model" in detail
    for event in events:
        assert event["message_zh"] and event["message_en"]


def test_events_stream_first_event_only(client: TestClient) -> None:
    run_id = _create_sample_run(client)

    with client.stream("GET", f"/v1/runs/{run_id}/events", params={"after": 0}) as stream:
        first = next(line for line in stream.iter_lines() if line.startswith("data: "))

    event = json.loads(first[len("data: ") :])
    assert event["seq"] == 1
    assert event["stage"] == "INGESTING"
    assert event["status"] == "STARTED"


# --------------------------------------------------------------------------------------
# restart safety, deletion, replay, auth, docs, demo
# --------------------------------------------------------------------------------------


def test_restart_safety_new_app_reads_run_from_disk(settings: Settings) -> None:
    with TestClient(create_app(settings)) as first:
        run_id = _create_sample_run(first)
        _decide_all(first, run_id)

    with TestClient(create_app(settings)) as second:
        detail = second.get(f"/v1/runs/{run_id}")
        assert detail.status_code == 200
        assert detail.json()["lifecycle"] == "REVIEW_REQUIRED"
        assert detail.json()["decisions"]
        assert second.get("/v1/runs").json()[0]["run_id"] == run_id
        dry = second.post(f"/v1/runs/{run_id}/dry-run")
        assert dry.status_code == 200


def test_apply_recovers_after_completed_execution_finalization_is_interrupted(
    settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    app = create_app(settings)
    body: dict[str, Any]
    with TestClient(app, raise_server_exceptions=False) as first:
        created = first.post(
            "/v1/runs",
            files={
                "file": ("sample.csv", SMALL_CSV, "text/csv"),
                "policy": ("contract.yaml", SMALL_CONTRACT, "application/yaml"),
            },
        )
        run_id = str(created.json()["run_id"])
        dry_run = first.post(f"/v1/runs/{run_id}/dry-run").json()["dry_run"]
        body = {
            "run_revision": 1,
            "approved_action_set_hash": dry_run["approved_action_set_hash"],
            "idempotency_key": "recover-apply-0001",
        }
        store = app.state.context.store
        write_json = store.write_json

        def interrupt_completed_state(target_run_id: str, name: str, obj: Any) -> Path:
            if name == "apply-idempotency.json" and isinstance(obj, dict) and (
                obj.get("state") == "COMPLETED"
            ):
                raise OSError("injected finalization interruption")
            return write_json(target_run_id, name, obj)

        monkeypatch.setattr(store, "write_json", interrupt_completed_state)
        interrupted = first.post(f"/v1/runs/{run_id}/apply", json=body)

        assert interrupted.status_code == 500
        assert store.has(run_id, "execution.json")
        assert store.read_json(run_id, "apply-idempotency.json")["state"] == "PENDING"
        assert store.read_meta(run_id)["lifecycle"] == "DRY_RUN_READY"
        assert first.get(f"/v1/runs/{run_id}").json()["execution"] is None
        visible = {item["name"] for item in first.get(f"/v1/runs/{run_id}/artifacts").json()}
        assert "release.csv" not in visible
        pending_release = first.get(f"/v1/runs/{run_id}/artifacts/release.csv")
        assert pending_release.status_code == 409
        assert pending_release.json()["error"]["code"] == "APPLY_INCOMPLETE"

    restarted = create_app(settings)
    with TestClient(restarted) as second:
        recovered = second.post(f"/v1/runs/{run_id}/apply", json=body)
        replayed = second.post(f"/v1/runs/{run_id}/apply", json=body)
        recovered_store = restarted.state.context.store

        assert recovered.status_code == 200
        assert recovered.headers["X-Idempotent-Replay"] == "true"
        assert replayed.status_code == 200
        assert replayed.json() == recovered.json()
        assert recovered_store.read_meta(run_id)["lifecycle"] == "APPLIED"
        assert recovered_store.read_json(run_id, "apply-idempotency.json")["state"] == "COMPLETED"
        assert sum(event.stage == "APPLIED" for event in recovered_store.read_events(run_id)) == 1
        assert second.get(f"/v1/runs/{run_id}").json()["execution"] is not None
        assert second.get(f"/v1/runs/{run_id}/artifacts/release.csv").status_code == 200


def test_delete_run_and_bulk_cleanup(client: TestClient) -> None:
    run_a = _create_sample_run(client)
    created = client.post("/v1/runs", files={"file": ("sample.csv", SMALL_CSV, "text/csv")})
    run_b = created.json()["run_id"]

    deleted = client.delete(f"/v1/runs/{run_a}")
    assert deleted.status_code == 204
    assert client.get(f"/v1/runs/{run_a}").status_code == 404
    assert client.delete(f"/v1/runs/{run_a}").status_code == 404

    kept = client.delete("/v1/runs", params={"older_than_minutes": 60})
    assert kept.json() == {"deleted": 0}
    assert client.get(f"/v1/runs/{run_b}").status_code == 200

    swept = client.delete("/v1/runs", params={"older_than_minutes": 0})
    assert swept.json() == {"deleted": 1}
    assert client.get("/v1/runs").json() == []


def test_replay_creates_child_run_with_identical_hashes(client: TestClient) -> None:
    parent = _create_sample_run(client)

    replayed = client.post(f"/v1/runs/{parent}/replay")
    assert replayed.status_code == 202
    child = replayed.json()["run_id"]
    assert replayed.json()["parent_run_id"] == parent
    assert child != parent

    parent_report = client.get(f"/v1/runs/{parent}").json()["report"]
    child_report = client.get(f"/v1/runs/{child}").json()["report"]
    assert child_report["profile"]["dataset_hash"] == parent_report["profile"]["dataset_hash"]
    assert child_report["profile"]["scope_hash"] == parent_report["profile"]["scope_hash"]
    assert child_report["contract"]["hash"] == parent_report["contract"]["hash"]
    assert [f["finding_id"] for f in child_report["findings"]] == [
        f["finding_id"] for f in parent_report["findings"]
    ]


def test_bearer_token_guards_v1_but_not_health(data_dir: Path) -> None:
    app = create_app(Settings(data_dir=data_dir, sync_pipeline=True, api_token="booth-secret"))
    with TestClient(app) as client:
        assert client.get("/health").status_code == 200

        denied = client.get("/v1/runs")
        assert denied.status_code == 401
        assert denied.json()["error"]["code"] == "UNAUTHORIZED"
        assert denied.headers["X-Correlation-Id"]

        wrong = client.get("/v1/runs", headers={"Authorization": "Bearer nope"})
        assert wrong.status_code == 401

        allowed = client.get("/v1/runs", headers={"Authorization": "Bearer booth-secret"})
        assert allowed.status_code == 200


def test_docs_can_be_disabled(data_dir: Path) -> None:
    with TestClient(
        create_app(Settings(data_dir=data_dir, sync_pipeline=True, docs_enabled=False))
    ) as client:
        assert client.get("/docs").status_code == 404
        assert client.get("/openapi.json").status_code == 404
        assert client.get("/docs").json()["error"]["code"] == "NOT_FOUND"


def test_contract_draft_endpoints(client: TestClient) -> None:
    created = client.post("/v1/runs", files={"file": ("sample.csv", SMALL_CSV, "text/csv")})
    run_id = created.json()["run_id"]

    missing = client.get(f"/v1/runs/{run_id}/contract/draft")
    assert missing.status_code == 404
    assert missing.json()["error"]["code"] == "DRAFT_NOT_FOUND"

    started = client.post(f"/v1/runs/{run_id}/contract/draft")
    assert started.status_code == 202
    assert started.json()["status"] == "pending"

    draft = client.get(f"/v1/runs/{run_id}/contract/draft")
    assert draft.status_code == 200
    body = draft.json()
    assert body["status"] in ("ready", "failed")
    if body["status"] == "ready":
        assert body["draft_yaml"]
        replaced = client.put(f"/v1/runs/{run_id}/contract", json={"yaml": body["draft_yaml"]})
        assert replaced.status_code == 202
        assert client.get(f"/v1/runs/{run_id}/contract").json()["source"] == "drafted"
    stages = [e["stage"] for e in _read_events(client, run_id)]
    assert "CONTRACT_DRAFTING" in stages


def test_brief_requires_execution(client: TestClient) -> None:
    run_id = _create_sample_run(client)

    response = client.get(f"/v1/runs/{run_id}/brief")

    assert response.status_code == 409
    assert response.json()["error"]["code"] == "EXECUTION_MISSING"


def test_demo_endpoints_keep_compatibility_shapes(client: TestClient) -> None:
    report = client.get("/v1/demo/clinical-nlp")
    assert report.status_code == 200
    assert report.json()["profile"]["record_count"] == 5_200
    assert report.json()["release_status"] == "BLOCKED"

    release = client.get("/v1/demo/clinical-nlp/release")
    assert release.status_code == 200
    body = release.json()
    assert body["analysis"]["profile"]["record_count"] == 5_200
    assert body["execution"]["release_manifest"]["release_status"] in ("CONDITIONAL_PASS", "PASS")


# --------------------------------------------------------------------------------------
# every sample (spec §10), red-team harness and live semantic re-run (spec §5.2b, §5.6)
# --------------------------------------------------------------------------------------


@pytest.mark.parametrize("sample_id", ["ecommerce_orders", "hr_roster", "uci_online_retail"])
def test_every_sample_full_flow_via_api(client: TestClient, sample_id: str) -> None:
    run_id = _create_sample_run(client, sample_id)
    detail = client.get(f"/v1/runs/{run_id}").json()
    assert detail["lifecycle"] == "REVIEW_REQUIRED", detail.get("error")
    assert detail["report"]["release_status"] == "BLOCKED"
    assert detail["report"]["contract"]["source"] == "sample"

    decided = _decide_all(client, run_id)
    assert decided["unresolved"] == []
    dry = client.post(f"/v1/runs/{run_id}/dry-run")
    assert dry.status_code == 200, dry.text
    dry_run = dry.json()["dry_run"]
    assert dry_run["blocking_unresolved"] == []
    applied = client.post(
        f"/v1/runs/{run_id}/apply",
        json={"run_revision": 1, "approved_action_set_hash": dry_run["approved_action_set_hash"]},
        headers={"Idempotency-Key": f"apply-{sample_id}-0001"},
    )
    assert applied.status_code == 200, applied.text
    execution = applied.json()
    assert execution["release_manifest"]["release_status"] == "CONDITIONAL_PASS"
    assert execution["release_manifest"]["validation_summary"] == {"passed": 14, "failed": 0}
    verify = client.get(f"/v1/runs/{run_id}/verify")
    assert verify.status_code == 200
    assert verify.json()["ok"] is True, [c for c in verify.json()["checks"] if not c["passed"]]
    names = {item["name"] for item in client.get(f"/v1/runs/{run_id}/artifacts").json()}
    assert {"release.csv", "candidate.csv", "changes.jsonl", "release-manifest.json"} <= names


def test_sample_without_contract_is_observational_via_api(client: TestClient) -> None:
    created = client.post(
        "/v1/runs/from-sample", json={"sample_id": "ecommerce_orders", "with_contract": False}
    )
    assert created.status_code == 202
    run_id = created.json()["run_id"]
    detail = client.get(f"/v1/runs/{run_id}").json()
    assert detail["lifecycle"] == "OBSERVATIONAL"
    assert detail["report"]["release_status"] == "NOT_EVALUATED"
    assert detail["report"]["contract"]["source"] == "baseline"
    refused = client.post(f"/v1/runs/{run_id}/dry-run")
    assert refused.status_code == 409
    assert refused.json()["error"]["code"] == "NOT_EVALUATED"


def _semantic_finding_id(client: TestClient, run_id: str) -> str:
    report = client.get(f"/v1/runs/{run_id}").json()["report"]
    return str(
        next(f for f in report["findings"] if f["finding_type"] == "SEMANTIC_VARIANT")["finding_id"]
    )


def test_redteam_cases_are_stored_outside_the_report(client: TestClient, data_dir: Path) -> None:
    run_id = _create_sample_run(client, "ecommerce_orders")
    finding_id = _semantic_finding_id(client, run_id)
    assert finding_id == "SEM-city"

    unknown = client.post(f"/v1/runs/{run_id}/findings/{finding_id}/redteam", json={"case": "X"})
    assert unknown.status_code == 422
    assert unknown.json()["error"]["code"] == "REDTEAM_CASE_UNKNOWN"
    not_semantic = client.post(
        f"/v1/runs/{run_id}/findings/DUP-EXACT/redteam", json={"case": "UNSUPPORTED_ACTION"}
    )
    assert not_semantic.status_code == 422
    assert not_semantic.json()["error"]["code"] == "NOT_A_SEMANTIC_FINDING"

    expected_status = {
        "HALLUCINATED_SOURCE_VALUE": "grounding_rejected",
        "UNKNOWN_CANONICAL_TARGET": "grounding_rejected",
        "UNKNOWN_EVIDENCE_REFERENCE": "grounding_rejected",
        "UNSUPPORTED_ACTION": "schema_rejected",
        "STALE_OR_UNKNOWN_INPUT": "grounding_rejected",
        "ABSTENTION_WITH_MAPPING": "grounding_rejected",
        "AMBIGUITY_REGISTRY_HIT": "grounding_rejected",
    }
    for case, status in expected_status.items():
        response = client.post(
            f"/v1/runs/{run_id}/findings/{finding_id}/redteam", json={"case": case}
        )
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["case"] == case
        assert body["status"] == status, (case, body)
        assert body["grounding"]["valid"] is False
        assert body["original_proposal"]["finding_id"] == finding_id
        assert body["simulated"] is True
        assert body["stored_as"] == f"redteam/{case}-1.json"
        assert (data_dir / "runs" / run_id / "redteam" / f"{case}-1.json").is_file()

    # TIMEOUT exercises the fail-closed path without the network and records a ledger row.
    timeout = client.post(
        f"/v1/runs/{run_id}/findings/{finding_id}/redteam", json={"case": "TIMEOUT"}
    )
    assert timeout.status_code == 200
    assert timeout.json()["status"] == "fallback_deterministic"
    assert timeout.json()["ledger_call_id"]
    ledger = client.get(f"/v1/runs/{run_id}/ai-ledger").json()
    timeout_record = next(r for r in ledger if r["task"] == "redteam")
    assert timeout_record["provider"] == "deterministic"
    assert timeout_record["status"] == "fallback_deterministic"
    assert "fallback_reason=timeout" in timeout_record["error"]

    # Second run of the same case gets the next sequence number.
    again = client.post(
        f"/v1/runs/{run_id}/findings/{finding_id}/redteam", json={"case": "UNSUPPORTED_ACTION"}
    )
    assert again.json()["stored_as"] == "redteam/UNSUPPORTED_ACTION-2.json"

    # Nothing about the run changed: report, decisions and verify are untouched.
    detail = client.get(f"/v1/runs/{run_id}").json()
    assert detail["lifecycle"] == "REVIEW_REQUIRED"
    assert detail["decisions"] == {}
    assert "redteam" not in json.dumps(detail["report"])
    artifacts = {item["name"] for item in client.get(f"/v1/runs/{run_id}/artifacts").json()}
    assert not any(name.startswith("redteam") for name in artifacts)


def test_semantic_rerun_updates_proposal_and_invalidates_dry_run(client: TestClient) -> None:
    run_id = _create_sample_run(client, "hr_roster")
    finding_id = _semantic_finding_id(client, run_id)
    assert finding_id == "SEM-employment_type"
    _decide_all(client, run_id)
    assert client.post(f"/v1/runs/{run_id}/dry-run").status_code == 200
    assert client.get(f"/v1/runs/{run_id}").json()["lifecycle"] == "DRY_RUN_READY"
    ledger_before = len(client.get(f"/v1/runs/{run_id}/ai-ledger").json())

    response = client.post(f"/v1/runs/{run_id}/findings/{finding_id}/semantic")
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["finding"]["finding_id"] == finding_id
    assert body["finding"]["proposal"]["mapping"] == {"FULL-TIME": "全职"}
    assert body["ledger_call_id"] == body["finding"]["proposal"]["ledger_call_id"]
    assert body["run_revision"] == 1
    assert body["unresolved"] == []

    detail = client.get(f"/v1/runs/{run_id}").json()
    assert detail["lifecycle"] == "REVIEW_REQUIRED"
    assert detail["dry_run"] is None and detail["preview"] is None
    assert set(detail["decisions"]) >= {finding_id, "VAL-employment_type"}
    updated = next(f for f in detail["report"]["findings"] if f["finding_id"] == finding_id)
    assert updated["proposal"]["ledger_call_id"] == body["ledger_call_id"]
    ledger = client.get(f"/v1/runs/{run_id}/ai-ledger").json()
    assert len(ledger) == ledger_before + 1  # exactly one new call
    assert ledger[-1]["finding_id"] == finding_id
    events = _read_events(client, run_id)
    assert events[-1]["stage"] == "SEMANTIC_ANALYSIS" and events[-1]["status"] == "INFO"
    assert events[-1]["detail"]["finding_id"] == finding_id

    not_semantic = client.post(f"/v1/runs/{run_id}/findings/DUP-KEY/semantic")
    assert not_semantic.status_code == 422
    missing = client.post(f"/v1/runs/{run_id}/findings/SEM-nope/semantic")
    assert missing.status_code == 404

    # Applied runs are immutable.
    dry = client.post(f"/v1/runs/{run_id}/dry-run").json()["dry_run"]
    applied = client.post(
        f"/v1/runs/{run_id}/apply",
        json={"run_revision": 1, "approved_action_set_hash": dry["approved_action_set_hash"]},
        headers={"Idempotency-Key": "apply-after-rerun-01"},
    )
    assert applied.status_code == 200, applied.text
    frozen = client.post(f"/v1/runs/{run_id}/findings/{finding_id}/semantic")
    assert frozen.status_code == 409
    assert frozen.json()["error"]["code"] == "RUN_APPLIED"


def test_verify_cli_matches_endpoint(client: TestClient, data_dir: Path) -> None:
    from datapilot.__main__ import main as cli_main

    run_id = _create_sample_run(client, "hr_roster")
    _decide_all(client, run_id)
    dry = client.post(f"/v1/runs/{run_id}/dry-run").json()["dry_run"]
    applied = client.post(
        f"/v1/runs/{run_id}/apply",
        json={"run_revision": 1, "approved_action_set_hash": dry["approved_action_set_hash"]},
        headers={"Idempotency-Key": "apply-cli-verify-01"},
    )
    assert applied.status_code == 200
    run_dir = data_dir / "runs" / run_id
    assert cli_main(["verify", str(run_dir), "--lang", "en"]) == 0
    tampered = run_dir / "release.csv"
    tampered.write_bytes(tampered.read_bytes() + b"x")
    assert cli_main(["verify", str(run_dir)]) == 1
    assert client.get(f"/v1/runs/{run_id}/verify").json()["ok"] is False
