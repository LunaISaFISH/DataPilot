"""Public-mode abuse controls, durable AI budget, and retention tests."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest
from datapilot.ai import get_runtime
from datapilot.ai.provider import AnthropicProvider, PersistentDailyCallBudget
from datapilot.api.main import Settings, create_app
from datapilot.contracts.models import AIStatus, ProviderName, SemanticRequest
from datapilot.pipeline import Pipeline
from datapilot.public_runtime import _is_ai_endpoint, cleanup_expired_runs, public_seed_run_id
from datapilot.storage import RunStore
from fastapi.testclient import TestClient


class _NetworkMustNotRun:
    calls = 0

    @property
    def beta(self) -> _NetworkMustNotRun:
        return self

    @property
    def messages(self) -> _NetworkMustNotRun:
        return self

    def create(self, **_kwargs: Any) -> object:
        self.calls += 1
        raise AssertionError("daily cap must prevent the network dispatch")


def _semantic_request() -> SemanticRequest:
    return SemanticRequest(
        finding_id="SEM-city",
        column="city",
        candidate_counts={"Shang Hai": 1},
        canonical_vocabulary=["上海"],
        evidence_refs=["EVID-01"],
        ambiguity_tokens=[],
    )


def test_public_upload_limit_returns_structured_429(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("DATAPILOT_AI_MODE", "replay")
    settings = Settings(
        data_dir=tmp_path,
        sync_pipeline=True,
        public_mode=True,
        uploads_per_minute=2,
        ai_requests_per_hour=20,
    )

    with TestClient(create_app(settings)) as client:
        headers = {"Fly-Client-IP": "203.0.113.10"}
        first = client.post(
            "/v1/runs/from-sample", json={"sample_id": "missing"}, headers=headers
        )
        second = client.post(
            "/v1/runs/from-sample", json={"sample_id": "missing"}, headers=headers
        )
        limited = client.post(
            "/v1/runs/from-sample", json={"sample_id": "missing"}, headers=headers
        )
        other_client = client.post(
            "/v1/runs/from-sample",
            json={"sample_id": "missing"},
            headers={"Fly-Client-IP": "203.0.113.11"},
        )

    assert first.status_code == 404
    assert second.status_code == 404
    assert limited.status_code == 429
    assert limited.json()["error"]["code"] == "UPLOAD_RATE_LIMIT_EXCEEDED"
    assert int(limited.headers["Retry-After"]) >= 1
    assert other_client.status_code == 404


@pytest.mark.parametrize(
    ("method", "path", "expected"),
    [
        ("POST", "/v1/runs/from-sample", True),
        ("POST", "/v1/runs/run-1/contract/draft", True),
        ("POST", "/v1/runs/run-1/findings/finding-1/semantic", True),
        ("POST", "/v1/runs/run-1/findings/finding-1/redteam", True),
        ("GET", "/v1/runs/run-1/brief", False),
    ],
)
def test_ai_request_limit_only_counts_triggering_routes(
    method: str, path: str, expected: bool
) -> None:
    assert _is_ai_endpoint(method, path) is expected


def test_daily_budget_is_persistent_and_fails_closed_at_cap(tmp_path: Path) -> None:
    first = PersistentDailyCallBudget(tmp_path, cap=1)
    second = PersistentDailyCallBudget(tmp_path, cap=1)

    assert first.reserve() == (True, None)
    allowed, reason = second.reserve()
    status = second.status()

    assert allowed is False
    assert reason == "AI_DAILY_CALL_CAP_EXCEEDED"
    assert status["calls_used"] == 1
    assert status["remaining"] == 0
    assert status["exhausted"] is True


def test_provider_cap_uses_deterministic_fallback_and_honest_ledger(tmp_path: Path) -> None:
    client = _NetworkMustNotRun()
    provider = AnthropicProvider(
        client=client,
        daily_budget=PersistentDailyCallBudget(tmp_path, cap=0),
    )
    runtime = get_runtime(provider=provider, mode="auto")

    outcome = runtime.semantic("run-public-cap", _semantic_request())

    assert client.calls == 0
    assert outcome.record.status is AIStatus.FALLBACK_DETERMINISTIC
    assert outcome.record.provider is ProviderName.DETERMINISTIC
    assert outcome.record.error is not None
    assert "AI_DAILY_CALL_CAP_EXCEEDED" in outcome.record.error


def test_retention_deletes_visitors_but_preserves_public_seed(tmp_path: Path) -> None:
    store = RunStore(tmp_path / "runs")
    pipeline = Pipeline(store, get_runtime(store, mode="replay"), sync=True)
    visitor = "visitor-run"
    seed = public_seed_run_id("tiny")
    old = (datetime.now(UTC) - timedelta(hours=25)).isoformat().replace("+00:00", "Z")
    for run_id in (visitor, seed):
        store.create(run_id, b"id\n1\n", "tiny.csv", None, None)
        store.update_meta(run_id, created_at=old)

    deleted = cleanup_expired_runs(store, pipeline, 24)

    assert deleted == 1
    assert store.exists(visitor) is False
    assert store.exists(seed) is True
