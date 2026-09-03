from datapilot.api.main import app
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

