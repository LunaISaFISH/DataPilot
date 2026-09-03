from datapilot.api.main import app
from datapilot.fixtures.clinical_nlp import generate_csv_bytes
from datapilot.governance import demo_decisions
from fastapi.testclient import TestClient

client = TestClient(app)


def test_demo_endpoint_returns_real_engine_report() -> None:
    response = client.get("/v1/demo/clinical-nlp")

    assert response.status_code == 200
    assert response.json()["profile"]["record_count"] == 5_200
    assert response.json()["release_status"] == "BLOCKED"


def test_upload_creates_observational_run() -> None:
    response = client.post(
        "/v1/runs",
        files={"file": ("sample.csv", b"id,value\n1,Alpha\n2,Beta\n", "text/csv")},
    )

    assert response.status_code == 201
    assert response.json()["report"]["release_status"] == "NOT_EVALUATED"
    assert response.json()["run_id"]


def test_policy_run_can_be_decided_dry_run_and_applied(
    clinical_policy_bytes: bytes,
) -> None:
    created = client.post(
        "/v1/runs",
        files={
            "file": ("clinical.csv", generate_csv_bytes(), "text/csv"),
            "policy": (
                "policy.yaml",
                clinical_policy_bytes,
                "application/yaml",
            ),
        },
    )
    run_id = created.json()["run_id"]
    for decision in demo_decisions():
        response = client.post(
            f"/v1/runs/{run_id}/findings/{decision.finding_id}/decision",
            json=decision.model_dump(mode="json"),
        )
        assert response.status_code == 200
    dry_run = client.post(f"/v1/runs/{run_id}/dry-run")
    applied = client.post(
        f"/v1/runs/{run_id}/apply",
        json={
            "run_revision": 1,
            "approved_action_set_hash": dry_run.json()["approved_action_set_hash"],
            "idempotency_key": "test-apply-0001",
        },
    )

    assert created.status_code == 201
    assert dry_run.status_code == 200
    assert applied.status_code == 200
    assert applied.json()["release_manifest"]["release_status"] == "CONDITIONAL_PASS"
