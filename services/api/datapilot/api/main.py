from __future__ import annotations

import os
import uuid
from pathlib import Path
from typing import Annotated, Any

import yaml
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware

from datapilot.contracts.models import RunCreated, RunReport
from datapilot.engine import AnalysisError, analyze_csv, load_policy
from datapilot.fixtures.clinical_nlp import generate_csv_bytes
from datapilot.serialization import atomic_write_bytes, atomic_write_json

PROJECT_ROOT = Path(__file__).resolve().parents[4]
DATA_ROOT = Path(os.environ.get("DATAPILOT_DATA_DIR", PROJECT_ROOT / ".data"))
FIXTURE_POLICY = PROJECT_ROOT / "fixtures" / "clinical_nlp" / "policy.yaml"
MAX_POLICY_BYTES = 64 * 1024

app = FastAPI(
    title="DataPilot API",
    version="0.1.0",
    description="Deterministic dataset profiling and release-governance API.",
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        origin.strip()
        for origin in os.environ.get(
            "DATAPILOT_ALLOWED_ORIGINS",
            "http://localhost:3000,http://127.0.0.1:3000",
        ).split(",")
        if origin.strip()
    ],
    allow_credentials=True,
    allow_methods=["GET", "POST", "DELETE"],
    allow_headers=["Content-Type", "Idempotency-Key"],
)

_reports: dict[str, RunReport] = {}


def _policy_from_bytes(content: bytes) -> dict[str, Any]:
    if len(content) > MAX_POLICY_BYTES:
        raise HTTPException(status_code=413, detail="Policy Pack exceeds 64 KiB.")
    try:
        value = yaml.safe_load(content.decode("utf-8"))
    except (UnicodeDecodeError, yaml.YAMLError) as error:
        raise HTTPException(
            status_code=422,
            detail="Policy Pack is not valid UTF-8 YAML.",
        ) from error
    if not isinstance(value, dict):
        raise HTTPException(status_code=422, detail="Policy Pack must be a mapping.")
    return value


def _store_run(run_id: str, source: bytes, report: RunReport) -> None:
    run_root = DATA_ROOT / "runs" / run_id
    atomic_write_bytes(run_root / "source.csv", source)
    atomic_write_json(run_root / "report.json", report.model_dump(mode="json"))
    _reports[run_id] = report


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/v1/demo/clinical-nlp", response_model=RunReport)
def clinical_nlp_demo() -> RunReport:
    return analyze_csv(
        generate_csv_bytes(),
        load_policy(FIXTURE_POLICY),
        synthetic=True,
        fixture_version="clinical-nlp-1.0.0",
    )


@app.post("/v1/runs", response_model=RunCreated, status_code=201)
async def create_run(
    file: Annotated[UploadFile, File()],
    policy: Annotated[UploadFile | None, File()] = None,
) -> RunCreated:
    source = await file.read(25 * 1024 * 1024 + 1)
    active_policy = None
    if policy is not None:
        active_policy = _policy_from_bytes(await policy.read(MAX_POLICY_BYTES + 1))
    try:
        report = analyze_csv(source, active_policy)
    except AnalysisError as error:
        raise HTTPException(
            status_code=422,
            detail={"code": error.code, "message": str(error)},
        ) from error
    run_id = uuid.uuid4().hex
    _store_run(run_id, source, report)
    return RunCreated(run_id=run_id, report=report)


@app.get("/v1/runs/{run_id}", response_model=RunReport)
def get_run(run_id: str) -> RunReport:
    report = _reports.get(run_id)
    if report is None:
        report_path = DATA_ROOT / "runs" / run_id / "report.json"
        if not report_path.exists():
            raise HTTPException(status_code=404, detail="Run not found.")
        report = RunReport.model_validate_json(report_path.read_text(encoding="utf-8"))
        _reports[run_id] = report
    return report


@app.delete("/v1/runs/{run_id}", status_code=204)
def delete_run(run_id: str) -> None:
    _reports.pop(run_id, None)
    run_root = DATA_ROOT / "runs" / run_id
    if not run_root.exists():
        raise HTTPException(status_code=404, detail="Run not found.")
    for child in run_root.iterdir():
        if child.is_file():
            child.unlink()
    run_root.rmdir()
