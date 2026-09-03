from __future__ import annotations

import os
import uuid
from pathlib import Path
from typing import Annotated, Any

import yaml
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

from datapilot.contracts.models import (
    ApplyRequest,
    DemoRelease,
    DryRunReport,
    ExecutionResult,
    HumanDecision,
    ReleaseStatus,
    RunCreated,
    RunReport,
)
from datapilot.engine import AnalysisError, analyze_csv, baseline_policy, load_policy
from datapilot.fixtures.clinical_nlp import generate_csv_bytes
from datapilot.governance import GovernanceError, demo_decisions, execute, prepare_dry_run
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
_decisions: dict[str, dict[str, HumanDecision]] = {}
_dry_runs: dict[str, DryRunReport] = {}
_executions: dict[str, ExecutionResult] = {}
_idempotency: dict[tuple[str, str], ExecutionResult] = {}


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


def _store_run(
    run_id: str,
    source: bytes,
    policy: dict[str, Any],
    report: RunReport,
) -> None:
    run_root = DATA_ROOT / "runs" / run_id
    atomic_write_bytes(run_root / "source.csv", source)
    atomic_write_json(run_root / "policy.json", policy)
    atomic_write_json(run_root / "report.json", report.model_dump(mode="json"))
    _reports[run_id] = report


def _get_report(run_id: str) -> RunReport:
    report = _reports.get(run_id)
    if report is not None:
        return report
    report_path = DATA_ROOT / "runs" / run_id / "report.json"
    if not report_path.exists():
        raise HTTPException(status_code=404, detail="Run not found.")
    report = RunReport.model_validate_json(report_path.read_text(encoding="utf-8"))
    _reports[run_id] = report
    return report


def _get_policy(run_id: str) -> dict[str, Any]:
    policy_path = DATA_ROOT / "runs" / run_id / "policy.json"
    if not policy_path.exists():
        raise HTTPException(status_code=404, detail="Run not found.")
    return _policy_from_bytes(policy_path.read_bytes())


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


@app.get("/v1/demo/clinical-nlp/release", response_model=DemoRelease)
def clinical_nlp_demo_release() -> DemoRelease:
    source = generate_csv_bytes()
    policy = load_policy(FIXTURE_POLICY)
    analysis = analyze_csv(
        source,
        policy,
        synthetic=True,
        fixture_version="clinical-nlp-1.0.0",
    )
    dry_run = prepare_dry_run(analysis, demo_decisions())
    bundle = execute(source, policy, analysis, dry_run)
    return DemoRelease(analysis=analysis, execution=bundle.result)


@app.post("/v1/runs", response_model=RunCreated, status_code=201)
async def create_run(
    file: Annotated[UploadFile, File()],
    policy: Annotated[UploadFile | None, File()] = None,
) -> RunCreated:
    source = await file.read(25 * 1024 * 1024 + 1)
    active_policy = baseline_policy()
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
    _store_run(run_id, source, active_policy, report)
    return RunCreated(run_id=run_id, report=report)


@app.get("/v1/runs/{run_id}", response_model=RunReport)
def get_run(run_id: str) -> RunReport:
    return _get_report(run_id)


@app.post(
    "/v1/runs/{run_id}/findings/{finding_id}/decision",
    response_model=HumanDecision,
)
def record_decision(
    run_id: str,
    finding_id: str,
    decision: HumanDecision,
) -> HumanDecision:
    report = _get_report(run_id)
    if finding_id != decision.finding_id:
        raise HTTPException(status_code=422, detail="Finding ID does not match request path.")
    if finding_id not in {finding.finding_id for finding in report.findings}:
        raise HTTPException(status_code=404, detail="Finding not found.")
    _decisions.setdefault(run_id, {})[finding_id] = decision
    _dry_runs.pop(run_id, None)
    return decision


@app.post("/v1/runs/{run_id}/dry-run", response_model=DryRunReport)
def create_dry_run(run_id: str) -> DryRunReport:
    report = _get_report(run_id)
    if report.release_status is ReleaseStatus.NOT_EVALUATED:
        raise HTTPException(
            status_code=409,
            detail="A Data Contract is required before creating a release change set.",
        )
    try:
        dry_run = prepare_dry_run(
            report,
            list(_decisions.get(run_id, {}).values()),
        )
    except GovernanceError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    _dry_runs[run_id] = dry_run
    atomic_write_json(
        DATA_ROOT / "runs" / run_id / "dry-run.json",
        dry_run.model_dump(mode="json"),
    )
    return dry_run


@app.post("/v1/runs/{run_id}/apply", response_model=ExecutionResult)
def apply_run(run_id: str, request: ApplyRequest) -> ExecutionResult:
    existing = _idempotency.get((run_id, request.idempotency_key))
    if existing is not None:
        return existing
    dry_run = _dry_runs.get(run_id)
    if dry_run is None:
        raise HTTPException(status_code=409, detail="Create a dry run before apply.")
    if (
        request.run_revision != dry_run.run_revision
        or request.approved_action_set_hash != dry_run.approved_action_set_hash
    ):
        raise HTTPException(status_code=409, detail="Dry run is stale; create it again.")
    run_root = DATA_ROOT / "runs" / run_id
    source = (run_root / "source.csv").read_bytes()
    try:
        bundle = execute(source, _get_policy(run_id), _get_report(run_id), dry_run)
    except GovernanceError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    if bundle.result.release_manifest.release_status is ReleaseStatus.BLOCKED:
        raise HTTPException(status_code=409, detail="Validation failed; release was not published.")
    atomic_write_bytes(run_root / "candidate.csv", bundle.candidate_csv)
    atomic_write_bytes(run_root / "release.csv", bundle.release_csv)
    atomic_write_json(
        run_root / "release-manifest.json",
        bundle.result.release_manifest.model_dump(mode="json"),
    )
    atomic_write_json(run_root / "execution.json", bundle.result.model_dump(mode="json"))
    _executions[run_id] = bundle.result
    _idempotency[(run_id, request.idempotency_key)] = bundle.result
    return bundle.result


@app.get("/v1/runs/{run_id}/artifacts/release.csv")
def download_release(run_id: str) -> FileResponse:
    path = DATA_ROOT / "runs" / run_id / "release.csv"
    if not path.exists():
        raise HTTPException(status_code=409, detail="No validated release artifact is available.")
    return FileResponse(path, filename="datapilot-release.csv", media_type="text/csv")


@app.get("/v1/runs/{run_id}/artifacts/release-manifest.json")
def download_manifest(run_id: str) -> FileResponse:
    path = DATA_ROOT / "runs" / run_id / "release-manifest.json"
    if not path.exists():
        raise HTTPException(status_code=409, detail="No release manifest is available.")
    return FileResponse(path, filename="release-manifest.json", media_type="application/json")


@app.delete("/v1/runs/{run_id}", status_code=204)
def delete_run(run_id: str) -> None:
    _reports.pop(run_id, None)
    _decisions.pop(run_id, None)
    _dry_runs.pop(run_id, None)
    _executions.pop(run_id, None)
    for key in [key for key in _idempotency if key[0] == run_id]:
        _idempotency.pop(key, None)
    run_root = DATA_ROOT / "runs" / run_id
    if not run_root.exists():
        raise HTTPException(status_code=404, detail="Run not found.")
    for child in run_root.iterdir():
        if child.is_file():
            child.unlink()
    run_root.rmdir()
