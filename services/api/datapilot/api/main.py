"""HTTP API v2 (spec §7).

``create_app(settings)`` builds a fully isolated application (own ``RunStore``, AI runtime and
``Pipeline``); the module-level ``app`` is what uvicorn serves. Disk is the truth: every GET
reads the run directory, so a restarted process sees every run.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import threading
import time
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable, MutableMapping
from contextlib import asynccontextmanager, suppress
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Annotated, Any

from fastapi import FastAPI, File, Header, Query, Request, Response, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from pydantic import Field

from datapilot.ai import REDTEAM_CASES, AIRuntime, ai_contract_card, get_runtime
from datapilot.ai.provider import configure_public_provider, daily_budget_status
from datapilot.api.errors import (
    CORRELATION_HEADER,
    APIError,
    error_body,
    install_error_handlers,
    new_correlation_id,
)
from datapilot.api.sse import event_stream, sse_response
from datapilot.contracts.models import (
    AICallRecord,
    AIProposal,
    ChangePreview,
    ContractDraftResult,
    ContractPutRequest,
    ContractSource,
    ContractView,
    DecisionOutcome,
    DecisionsRequest,
    DemoRelease,
    DryRunReport,
    ErrorDetail,
    EventStatus,
    ExecutionResult,
    Finding,
    FromSampleRequest,
    GroundingResult,
    HealthInfo,
    HumanDecision,
    Lifecycle,
    ReleaseBrief,
    ReleaseStatus,
    RunCreated,
    RunDetail,
    RunReport,
    RunSummary,
    SampleInfo,
    SemanticRequest,
    StrictModel,
)
from datapilot.contracts.policy import (
    ContractError,
    DataContract,
    baseline_contract,
    contract_hash,
    contract_to_dict,
    contract_to_yaml,
    parse_contract,
)
from datapilot.engine import (
    ENGINE_VERSION,
    SemanticResolver,
    analyze_csv,
    deterministic_proposal,
    parse_csv,
)
from datapilot.governance import (
    demo_decisions,
    execute,
    prepare_dry_run,
    preview_changes,
    unresolved_findings,
    verify_run,
)
from datapilot.pipeline import Pipeline, sync_pipeline_from_env
from datapilot.public_runtime import (
    MAINTENANCE_INTERVAL_SECONDS,
    PublicRateLimitMiddleware,
    PublicRequestLimits,
    cleanup_expired_runs,
    is_public_seed,
    seed_public_samples,
)
from datapilot.samples import get_sample, list_samples, sample_contract_text, sample_is_synthetic
from datapilot.serialization import atomic_write_json
from datapilot.storage import (
    CONTRACT_FILE,
    EVENTS_FILE,
    LEDGER_FILE,
    META_FILE,
    SOURCE_FILE,
    RunStore,
    StorageError,
    utc_now_iso,
)

PROJECT_ROOT = Path(__file__).resolve().parents[4]
API_VERSION = "0.2.0"
MAX_UPLOAD_BYTES = 25 * 1024 * 1024
MAX_CONTRACT_BYTES = 64 * 1024
DEMO_SAMPLE_ID = "clinical_nlp"
MASK = "••••"

REPORT_FILE = "report.json"
DECISIONS_FILE = "decisions.json"
DRY_RUN_FILE = "dry-run.json"
PREVIEW_FILE = "preview.json"
EXECUTION_FILE = "execution.json"
CANDIDATE_FILE = "candidate.csv"
RELEASE_FILE = "release.csv"
MANIFEST_FILE = "release-manifest.json"
CHANGES_FILE = "changes.jsonl"
BRIEF_FILE = "brief.json"
DRAFT_FILE = "contract-draft.json"
IDEMPOTENCY_FILE = "apply-idempotency.json"
REDTEAM_DIR = "redteam"
SEMANTIC_FINDING_TYPE = "SEMANTIC_VARIANT"

ARTIFACT_ROLES: dict[str, str] = {
    META_FILE: "meta",
    SOURCE_FILE: "source",
    CONTRACT_FILE: "contract",
    REPORT_FILE: "report",
    DECISIONS_FILE: "decisions",
    DRY_RUN_FILE: "dry_run",
    PREVIEW_FILE: "preview",
    EXECUTION_FILE: "execution",
    CANDIDATE_FILE: "candidate",
    RELEASE_FILE: "release",
    MANIFEST_FILE: "manifest",
    CHANGES_FILE: "change_ledger",
    EVENTS_FILE: "events",
    LEDGER_FILE: "ai_ledger",
    BRIEF_FILE: "brief",
    DRAFT_FILE: "contract_draft",
    IDEMPOTENCY_FILE: "idempotency",
}
DOWNLOADABLE: dict[str, str] = {
    RELEASE_FILE: "text/csv",
    CANDIDATE_FILE: "text/csv",
    MANIFEST_FILE: "application/json",
    CHANGES_FILE: "application/x-ndjson",
    LEDGER_FILE: "application/x-ndjson",
    REPORT_FILE: "application/json",
    EVENTS_FILE: "application/x-ndjson",
    CONTRACT_FILE: "application/yaml",
}
AUDIT_BUNDLE = "audit-bundle.json"
# Files removed when a contract is replaced (revision bump) so nothing stale survives.
REVISION_SCOPED_FILES = (
    REPORT_FILE,
    DECISIONS_FILE,
    DRY_RUN_FILE,
    PREVIEW_FILE,
    EXECUTION_FILE,
    CANDIDATE_FILE,
    RELEASE_FILE,
    MANIFEST_FILE,
    CHANGES_FILE,
    BRIEF_FILE,
    IDEMPOTENCY_FILE,
)
APPLY_OUTPUT_FILES = frozenset(
    {CANDIDATE_FILE, RELEASE_FILE, MANIFEST_FILE, CHANGES_FILE, EXECUTION_FILE}
)


# --------------------------------------------------------------------------------------
# Settings
# --------------------------------------------------------------------------------------


def _env_flag(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _env_nonnegative_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    try:
        value = int(raw)
    except ValueError as error:
        raise ValueError(f"{name} must be a non-negative integer") from error
    if value < 0:
        raise ValueError(f"{name} must be a non-negative integer")
    return value


@dataclass(frozen=True)
class Settings:
    data_dir: Path
    allowed_origins: tuple[str, ...] = ("http://localhost:3000", "http://127.0.0.1:3000")
    sync_pipeline: bool = False
    api_token: str | None = None
    docs_enabled: bool = True
    public_mode: bool = False
    run_retention_hours: int = 24
    seed_samples: bool = False
    ai_daily_call_cap: int = 40
    uploads_per_minute: int = 10
    ai_requests_per_hour: int = 20

    def __post_init__(self) -> None:
        numeric = {
            "run_retention_hours": self.run_retention_hours,
            "ai_daily_call_cap": self.ai_daily_call_cap,
            "uploads_per_minute": self.uploads_per_minute,
            "ai_requests_per_hour": self.ai_requests_per_hour,
        }
        invalid = [name for name, value in numeric.items() if value < 0]
        if invalid:
            raise ValueError(f"Settings values must be non-negative: {', '.join(invalid)}")

    @classmethod
    def from_env(cls) -> Settings:
        public_mode = _env_flag("DATAPILOT_PUBLIC_MODE", False)
        origins = tuple(
            origin.strip()
            for origin in os.environ.get(
                "DATAPILOT_ALLOWED_ORIGINS", "http://localhost:3000,http://127.0.0.1:3000"
            ).split(",")
            if origin.strip()
        )
        token = os.environ.get("DATAPILOT_API_TOKEN", "").strip() or None
        return cls(
            data_dir=Path(os.environ.get("DATAPILOT_DATA_DIR", str(PROJECT_ROOT / ".data"))),
            allowed_origins=origins,
            sync_pipeline=sync_pipeline_from_env(),
            api_token=token,
            docs_enabled=_env_flag("DATAPILOT_DOCS", True),
            public_mode=public_mode,
            run_retention_hours=_env_nonnegative_int("DATAPILOT_RUN_RETENTION_HOURS", 24),
            seed_samples=_env_flag("DATAPILOT_SEED_SAMPLES", public_mode),
            ai_daily_call_cap=_env_nonnegative_int("DATAPILOT_AI_DAILY_CALL_CAP", 40),
            uploads_per_minute=_env_nonnegative_int("DATAPILOT_UPLOADS_PER_MINUTE", 10),
            ai_requests_per_hour=_env_nonnegative_int(
                "DATAPILOT_AI_REQUESTS_PER_HOUR", 20
            ),
        )


@dataclass
class AppContext:
    settings: Settings
    store: RunStore
    ai: AIRuntime
    pipeline: Pipeline
    apply_locks: dict[str, threading.Lock] = field(default_factory=dict)
    demo_cache: dict[str, DemoRelease] = field(default_factory=dict)
    _lock: threading.Lock = field(default_factory=threading.Lock)

    def apply_lock(self, run_id: str) -> threading.Lock:
        with self._lock:
            return self.apply_locks.setdefault(run_id, threading.Lock())


# --------------------------------------------------------------------------------------
# Local request models
# --------------------------------------------------------------------------------------


class RedteamBody(StrictModel):
    case: str


class ApplyBody(StrictModel):
    run_revision: int = Field(ge=1)
    approved_action_set_hash: str = Field(min_length=64, max_length=64)
    idempotency_key: str | None = Field(default=None, min_length=8, max_length=128)


# --------------------------------------------------------------------------------------
# ASGI middleware: correlation id, Server-Timing, optional bearer token
# --------------------------------------------------------------------------------------

Scope = MutableMapping[str, Any]
Message = MutableMapping[str, Any]
Receive = Callable[[], Awaitable[Message]]
Send = Callable[[Message], Awaitable[None]]
ASGIApp = Callable[[Scope, Receive, Send], Awaitable[None]]


class RequestContextMiddleware:
    def __init__(self, app: ASGIApp, *, api_token: str | None) -> None:
        self.app = app
        self.api_token = api_token

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope.get("type") != "http":
            await self.app(scope, receive, send)
            return
        correlation_id = new_correlation_id()
        state: dict[str, Any] = scope.setdefault("state", {})
        state["correlation_id"] = correlation_id
        started = time.perf_counter()

        if self.api_token is not None and not self._authorized(scope):
            response = JSONResponse(
                status_code=401,
                content=error_body(
                    "UNAUTHORIZED",
                    "缺少或无效的访问令牌。",
                    "Missing or invalid bearer token.",
                    retryable=False,
                    correlation_id=correlation_id,
                ),
                headers={CORRELATION_HEADER: correlation_id, "WWW-Authenticate": "Bearer"},
            )
            await response(scope, receive, send)
            return

        async def send_with_headers(message: Message) -> None:
            if message.get("type") == "http.response.start":
                headers: list[tuple[bytes, bytes]] = list(message.get("headers", []))
                names = {name.lower() for name, _ in headers}
                if CORRELATION_HEADER.lower().encode() not in names:
                    headers.append((CORRELATION_HEADER.lower().encode(), correlation_id.encode()))
                elapsed = (time.perf_counter() - started) * 1000
                headers.append((b"server-timing", f"total;dur={elapsed:.1f}".encode()))
                message["headers"] = headers
            await send(message)

        await self.app(scope, receive, send_with_headers)

    def _authorized(self, scope: Scope) -> bool:
        path = str(scope.get("path", ""))
        method = str(scope.get("method", "GET")).upper()
        if not path.startswith("/v1/") or method == "OPTIONS":
            return True
        for name, value in scope.get("headers", []):
            if name == b"authorization":
                scheme, _, token = value.decode("latin-1").partition(" ")
                return bool(scheme.lower() == "bearer" and token.strip() == self.api_token)
        return False


# --------------------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------------------


def _new_run_id() -> str:
    return uuid.uuid4().hex


def _record_uid(dataset_hash: str, ordinal: int) -> str:
    return hashlib.sha256(f"{dataset_hash}:{ordinal}".encode()).hexdigest()[:24]


def _lifecycle(meta: dict[str, Any]) -> Lifecycle:
    raw = meta.get("lifecycle")
    try:
        return Lifecycle(str(raw))
    except ValueError:
        return Lifecycle.FAILED


def _not_found(run_id: str) -> APIError:
    return APIError(
        404, "RUN_NOT_FOUND", f"运行 `{run_id}` 不存在。", f"Run `{run_id}` does not exist."
    )


def _meta(ctx: AppContext, run_id: str) -> dict[str, Any]:
    try:
        if not ctx.store.exists(run_id):
            raise _not_found(run_id)
        return ctx.store.read_meta(run_id)
    except StorageError as error:
        if error.code == "RUN_ID_INVALID":
            raise _not_found(run_id) from error
        raise


def _require_report(ctx: AppContext, run_id: str) -> tuple[dict[str, Any], RunReport]:
    meta = _meta(ctx, run_id)
    lifecycle = _lifecycle(meta)
    if lifecycle in (Lifecycle.QUEUED, Lifecycle.RUNNING):
        raise APIError(
            409,
            "RUN_BUSY",
            "分析仍在进行中，请等待事件流结束。",
            "Analysis is still running; wait for the event stream to finish.",
            retryable=True,
        )
    report = ctx.store.read_model(run_id, REPORT_FILE, RunReport)
    if report is None:
        stored = meta.get("error")
        code = stored.get("code") if isinstance(stored, dict) else None
        raise APIError(
            409,
            "REPORT_NOT_AVAILABLE",
            f"该运行没有可用的分析报告（{code or lifecycle.value}）。",
            f"The run has no analysis report ({code or lifecycle.value}).",
        )
    return meta, report


def _contract_of(ctx: AppContext, run_id: str) -> tuple[str, DataContract]:
    text = ctx.store.read_contract_yaml(run_id)
    if text is None:
        contract = baseline_contract()
        return contract_to_yaml(contract), contract
    return text, parse_contract(text)


def _contract_view(ctx: AppContext, run_id: str, meta: dict[str, Any]) -> ContractView:
    text, contract = _contract_of(ctx, run_id)
    stored = meta.get("contract_source")
    source = ContractSource.BASELINE
    if isinstance(stored, str):
        try:
            source = ContractSource(stored)
        except ValueError:
            source = ContractSource.BASELINE
    return ContractView(
        yaml=text, parsed=contract_to_dict(contract), hash=contract_hash(contract), source=source
    )


def _decisions(ctx: AppContext, run_id: str) -> dict[str, HumanDecision]:
    if not ctx.store.has(run_id, DECISIONS_FILE):
        return {}
    loaded = ctx.store.read_json(run_id, DECISIONS_FILE)
    if not isinstance(loaded, dict):
        return {}
    return {str(key): HumanDecision.model_validate(value) for key, value in loaded.items()}


def _error_detail(meta: dict[str, Any]) -> ErrorDetail | None:
    stored = meta.get("error")
    if not isinstance(stored, dict):
        return None
    try:
        return ErrorDetail.model_validate(stored)
    except ValueError:
        return None


def _run_detail(ctx: AppContext, run_id: str) -> RunDetail:
    ctx.pipeline.recover_analysis_state(run_id)
    meta = _meta(ctx, run_id)
    store = ctx.store
    lifecycle = _lifecycle(meta)
    report = store.read_model(run_id, REPORT_FILE, RunReport)
    contract: ContractView | None = None
    if report is not None or store.has(run_id, CONTRACT_FILE):
        try:
            contract = _contract_view(ctx, run_id, meta)
        except ContractError:
            contract = None
    return RunDetail(
        run_id=run_id,
        lifecycle=lifecycle,
        source_name=str(meta.get("source_name") or ""),
        sample_id=meta.get("sample_id") if isinstance(meta.get("sample_id"), str) else None,
        created_at=str(meta.get("created_at") or ""),
        run_revision=int(meta.get("run_revision") or 1),
        report=report,
        contract=contract,
        decisions=_decisions(ctx, run_id),
        dry_run=store.read_model(run_id, DRY_RUN_FILE, DryRunReport),
        preview=store.read_model(run_id, PREVIEW_FILE, ChangePreview),
        execution=(
            store.read_model(run_id, EXECUTION_FILE, ExecutionResult)
            if lifecycle is Lifecycle.APPLIED
            else None
        ),
        brief=store.read_model(run_id, BRIEF_FILE, ReleaseBrief),
        error=_error_detail(meta),
    )


def _start_run(
    ctx: AppContext,
    *,
    source: bytes,
    source_name: str,
    contract_yaml: str | None,
    sample_id: str | None,
    contract_source: ContractSource,
) -> RunCreated:
    run_id = _new_run_id()
    summary = ctx.store.create(run_id, source, source_name, contract_yaml, sample_id)
    ctx.store.update_meta(run_id, contract_source=contract_source.value)
    ctx.pipeline.submit_analysis(run_id)
    lifecycle = _lifecycle(ctx.store.read_meta(run_id))
    return RunCreated(run_id=run_id, lifecycle=lifecycle, run_revision=summary.run_revision)


def _parse_contract_text(raw: bytes | str) -> tuple[str, DataContract]:
    payload = raw.encode("utf-8") if isinstance(raw, str) else raw
    if len(payload) > MAX_CONTRACT_BYTES:
        raise APIError(
            413,
            "CONTRACT_TOO_LARGE",
            "契约文件超过 64 KiB。",
            "The contract exceeds 64 KiB.",
        )
    try:
        text = payload.decode("utf-8")
    except UnicodeDecodeError as error:
        raise APIError(
            422,
            "CONTRACT_ENCODING_INVALID",
            "契约必须是 UTF-8 编码的 YAML。",
            "The contract must be UTF-8 encoded YAML.",
        ) from error
    return text, parse_contract(text)


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _artifact_listing(ctx: AppContext, run_id: str) -> list[dict[str, Any]]:
    directory = ctx.store.run_dir(run_id)
    applied = _lifecycle(ctx.store.read_meta(run_id)) is Lifecycle.APPLIED
    items: list[dict[str, Any]] = []
    for path in sorted(directory.iterdir()):
        if (
            not path.is_file()
            or path.name.startswith(".")
            or (not applied and path.name in APPLY_OUTPUT_FILES)
        ):
            continue
        stat = path.stat()
        items.append(
            {
                "name": path.name,
                "role": ARTIFACT_ROLES.get(path.name, "other"),
                "bytes": stat.st_size,
                "sha256": _sha256_file(path),
                "modified_at": datetime.fromtimestamp(stat.st_mtime, UTC)
                .isoformat(timespec="milliseconds")
                .replace("+00:00", "Z"),
            }
        )
    return items


def _audit_bundle(ctx: AppContext, run_id: str) -> dict[str, Any]:
    meta = _meta(ctx, run_id)
    store = ctx.store
    applied = _lifecycle(meta) is Lifecycle.APPLIED

    def optional(name: str) -> Any:
        return store.read_json(run_id, name) if store.has(run_id, name) else None

    contract_text = store.read_contract_yaml(run_id)
    return {
        "bundle_version": "2.0",
        "generated_at": utc_now_iso(),
        "run": {key: meta.get(key) for key in meta if key != "error"},
        "report": optional(REPORT_FILE),
        "contract": {
            "yaml": contract_text,
            "hash": contract_hash(parse_contract(contract_text)) if contract_text else None,
        },
        "decisions": optional(DECISIONS_FILE) or {},
        "dry_run": optional(DRY_RUN_FILE),
        "execution": optional(EXECUTION_FILE) if applied else None,
        "ai_ledger": [record.model_dump(mode="json") for record in store.read_ledger(run_id)],
        "release_manifest": optional(MANIFEST_FILE) if applied else None,
    }


def _masked_rows(
    source: bytes,
    report: RunReport,
    contract: DataContract,
    finding: Finding,
    limit: int,
) -> dict[str, Any]:
    frame = parse_csv(source).frame
    dataset_hash = report.profile.dataset_hash
    wanted = finding.sample_record_uids or finding.record_uids[:limit]
    wanted = wanted[:limit]
    wanted_set = set(wanted)
    ordinal_by_uid: dict[str, int] = {}
    for position in range(frame.height):
        uid = _record_uid(dataset_hash, position)
        if uid in wanted_set:
            ordinal_by_uid[uid] = position
            if len(ordinal_by_uid) == len(wanted_set):
                break
    masked = set(contract.sensitive_fields()) | set(report.sensitive_preflight.columns_withheld)
    columns = list(frame.columns)
    rows: list[dict[str, Any]] = []
    for uid in wanted:
        ordinal = ordinal_by_uid.get(uid)
        if ordinal is None:
            continue
        raw = frame.row(ordinal, named=True)
        cells: dict[str, Any] = {}
        for column in columns:
            value = raw.get(column)
            if column in masked:
                cells[column] = None if value in (None, "") else MASK
            else:
                cells[column] = None if value is None else str(value)
        rows.append({"record_uid": uid, "ordinal": ordinal, "cells": cells})
    return {
        "columns": columns,
        "rows": rows,
        "masked_columns": sorted(column for column in masked if column in columns),
        "finding_id": finding.finding_id,
        "column": finding.column,
    }


def _semantic_finding(report: RunReport, finding_id: str) -> tuple[Finding, SemanticRequest]:
    """The ``SEM-<col>`` finding and the exact ``SemanticRequest`` the engine built for it."""
    finding = next((f for f in report.findings if f.finding_id == finding_id), None)
    if finding is None:
        raise APIError(
            404,
            "FINDING_NOT_FOUND",
            f"发现 `{finding_id}` 不存在。",
            f"Finding `{finding_id}` does not exist.",
        )
    raw_request = finding.details.get("request")
    if finding.finding_type != SEMANTIC_FINDING_TYPE or not isinstance(raw_request, dict):
        raise APIError(
            422,
            "NOT_A_SEMANTIC_FINDING",
            f"发现 `{finding_id}` 不是语义映射发现，没有 AI 请求可重放。",
            f"Finding `{finding_id}` is not a semantic-mapping finding; there is no AI request "
            "to replay.",
            observed=finding.finding_type,
            expected=SEMANTIC_FINDING_TYPE,
        )
    return finding, SemanticRequest.model_validate(raw_request)


def _proposal_of(finding: Finding, request: SemanticRequest) -> AIProposal:
    """Rebuild the finding's last proposal (AI or deterministic) as a full ``AIProposal``."""
    summary = finding.proposal
    if summary is None:
        return deterministic_proposal(request)
    mapping = dict(summary.mapping) if summary.mapping else None
    return AIProposal(
        finding_id=finding.finding_id,
        proposed_action="NORMALIZE_CATEGORY" if mapping else None,
        column=request.column,
        mapping=mapping,
        evidence_refs=list(request.evidence_refs),
        semantic_explanation=finding.explanation_en,
        ambiguity_flags=[],
        abstained=summary.abstained,
        abstain_reason=summary.abstain_reason,
        provider=summary.provider.value,
        model=summary.model,
        prompt_version=summary.prompt_version,
        input_hash=summary.input_hash,
    )


class _RerunResolver:
    """Live call for one finding; every other semantic finding replays its stored proposal.

    Re-running the analysis this way keeps the SEM/VAL split, the consistency conflicts and the
    metrics coherent with the new proposal while spending exactly one AI call.
    """

    def __init__(self, live: SemanticResolver, report: RunReport, target: str) -> None:
        self._live = live
        self._target = target
        self._stored = {
            f.finding_id: f for f in report.findings if f.finding_type == SEMANTIC_FINDING_TYPE
        }

    def resolve(
        self, request: SemanticRequest, *, run_id: str | None = None
    ) -> tuple[AIProposal, GroundingResult, str | None]:
        if request.finding_id == self._target:
            return self._live.resolve(request, run_id=run_id or "")
        stored = self._stored.get(request.finding_id)
        if stored is None or stored.proposal is None:
            fallback = deterministic_proposal(request)
            return fallback, GroundingResult(valid=True, reason_codes=[]), None
        return (
            _proposal_of(stored, request),
            stored.proposal.grounding,
            stored.proposal.ledger_call_id,
        )


def _next_redteam_path(directory: Path, case: str) -> tuple[Path, int]:
    directory.mkdir(parents=True, exist_ok=True)
    existing = [
        int(path.stem.rsplit("-", 1)[1])
        for path in directory.glob(f"{case}-*.json")
        if path.stem.rsplit("-", 1)[1].isdigit()
    ]
    index = (max(existing) + 1) if existing else 1
    return directory / f"{case}-{index}.json", index


def _idempotency_record(ctx: AppContext, run_id: str) -> dict[str, Any] | None:
    if not ctx.store.has(run_id, IDEMPOTENCY_FILE):
        return None
    loaded = ctx.store.read_json(run_id, IDEMPOTENCY_FILE)
    return loaded if isinstance(loaded, dict) else None


def _finalize_apply(
    ctx: AppContext,
    run_id: str,
    key: str,
    revision: int,
    result: ExecutionResult,
) -> None:
    """Commit a computed execution and repair an interrupted finalization idempotently."""
    previous = _idempotency_record(ctx, run_id) or {}
    if previous.get("state") != "COMPLETED":
        applied_at = previous.get("applied_at")
        ctx.store.write_json(
            run_id,
            IDEMPOTENCY_FILE,
            {
                "key": key,
                "state": "COMPLETED",
                "started_at": previous.get("started_at"),
                "applied_at": applied_at if isinstance(applied_at, str) else utc_now_iso(),
                "run_revision": revision,
                "approved_action_set_hash": result.dry_run.approved_action_set_hash,
            },
        )
    meta = ctx.store.read_meta(run_id)
    if _lifecycle(meta) is not Lifecycle.APPLIED:
        ctx.store.update_meta(
            run_id,
            lifecycle=Lifecycle.APPLIED.value,
            release_status=result.release_manifest.release_status.value,
        )
    release_hash = result.release_manifest.release_artifact_hash
    already_recorded = any(
        event.stage == "APPLIED"
        and event.status is EventStatus.COMPLETED
        and event.detail.get("release_artifact_hash") == release_hash
        for event in ctx.store.read_events(run_id)
    )
    if not already_recorded:
        ctx.store.append_event(
            run_id,
            "APPLIED",
            EventStatus.COMPLETED,
            f"发布已执行并验证：{result.release_manifest.release_status.value}",
            f"Release executed and validated: {result.release_manifest.release_status.value}",
            detail={
                "release_status": result.release_manifest.release_status.value,
                "validations": result.release_manifest.validation_summary,
                "release_artifact_hash": release_hash,
            },
        )


def _tamper(source: bytes) -> bytes:
    """Flip one byte of a copy of the source (a printable data byte, never the header)."""
    if not source:
        return b"x"
    payload = bytearray(source)
    header_end = payload.find(b"\n")
    start = header_end + 1 if 0 <= header_end < len(payload) - 1 else 0
    for index in range(len(payload) - 1, start - 1, -1):
        byte = payload[index]
        if 0x30 <= byte <= 0x39 or 0x41 <= byte <= 0x5A or 0x61 <= byte <= 0x7A:
            payload[index] = byte ^ 0x01
            return bytes(payload)
    payload[-1] ^= 0x01
    return bytes(payload)


def _data_dir_writable(path: Path) -> bool:
    try:
        path.mkdir(parents=True, exist_ok=True)
        probe = path / f".probe-{uuid.uuid4().hex}"
        probe.write_bytes(b"ok")
        probe.unlink()
        return True
    except OSError:
        return False


def _demo_release(ctx: AppContext) -> DemoRelease:
    """Clinical sample + contract through the real engine/governance, cached per process."""
    sample = get_sample(DEMO_SAMPLE_ID)
    source = sample.generate()
    contract_text = sample_contract_text(DEMO_SAMPLE_ID)
    contract = parse_contract(contract_text) if contract_text else baseline_contract()
    cache_key = f"{hashlib.sha256(source).hexdigest()}:{contract_hash(contract)}"
    cached = ctx.demo_cache.get(cache_key)
    if cached is not None:
        return cached
    demo_store = RunStore(ctx.settings.data_dir / "demo")
    demo_run_id = f"demo-{cache_key[:24]}"
    demo_store.delete(demo_run_id)
    demo_store.create(demo_run_id, source, f"{DEMO_SAMPLE_ID}.csv", contract_text, DEMO_SAMPLE_ID)
    demo_ai = get_runtime(demo_store, mode="replay")
    report = analyze_csv(
        source,
        contract,
        ai=demo_ai.semantic_resolver(demo_run_id),
        run_revision=1,
        run_id=demo_run_id,
        synthetic=True,
    )
    report = report.model_copy(
        update={"contract": report.contract.model_copy(update={"source": ContractSource.SAMPLE})}
    )
    dry_run = prepare_dry_run(report, demo_decisions(report), contract, run_revision=1)
    bundle = execute(
        source,
        contract,
        report,
        dry_run,
        ai_call_count=demo_store.ledger_count(demo_run_id),
        ai_provider=demo_ai.info().provider,
    )
    release = DemoRelease(analysis=report, execution=bundle.result)
    ctx.demo_cache[cache_key] = release
    return release


# --------------------------------------------------------------------------------------
# Application factory
# --------------------------------------------------------------------------------------


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings.from_env()
    store = RunStore(settings.data_dir / "runs")
    ai = get_runtime(store)
    if settings.public_mode:
        configure_public_provider(
            ai.provider,
            data_root=settings.data_dir,
            daily_call_cap=settings.ai_daily_call_cap,
        )
    pipeline = Pipeline(store, ai, sync=settings.sync_pipeline)
    ctx = AppContext(settings=settings, store=store, ai=ai, pipeline=pipeline)

    async def maintenance_loop() -> None:
        while True:
            await asyncio.sleep(MAINTENANCE_INTERVAL_SECONDS)
            await asyncio.to_thread(
                cleanup_expired_runs,
                store,
                pipeline,
                settings.run_retention_hours,
            )

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        maintenance: asyncio.Task[None] | None = None
        if settings.public_mode:
            await asyncio.to_thread(
                cleanup_expired_runs,
                store,
                pipeline,
                settings.run_retention_hours,
            )
            if settings.seed_samples:
                await asyncio.to_thread(seed_public_samples, store, pipeline)
            maintenance = asyncio.create_task(
                maintenance_loop(), name="datapilot-public-maintenance"
            )
        try:
            yield
        finally:
            if maintenance is not None:
                maintenance.cancel()
                with suppress(asyncio.CancelledError):
                    await maintenance

    app = FastAPI(
        title="DataPilot API",
        version=API_VERSION,
        description="Explainable dataset release gate: AI proposes, policy decides, humans decide "
        "high-risk, deterministic rules execute, validations gate release.",
        docs_url="/docs" if settings.docs_enabled else None,
        redoc_url=None,
        openapi_url="/openapi.json" if settings.docs_enabled else None,
        lifespan=lifespan,
    )
    app.state.context = ctx
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(settings.allowed_origins),
        allow_credentials=True,
        allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
        allow_headers=["Content-Type", "Idempotency-Key", "Authorization", "Last-Event-ID"],
        expose_headers=[
            CORRELATION_HEADER,
            "Server-Timing",
            "X-Idempotent-Replay",
            "Retry-After",
        ],
    )
    if settings.public_mode:
        app.add_middleware(
            PublicRateLimitMiddleware,
            limits=PublicRequestLimits(
                settings.uploads_per_minute,
                settings.ai_requests_per_hour,
            ),
        )
    app.add_middleware(RequestContextMiddleware, api_token=settings.api_token)
    install_error_handlers(app)

    # -- health & samples ---------------------------------------------------------------

    @app.get("/health")
    def health() -> dict[str, Any]:
        writable = _data_dir_writable(settings.data_dir)
        info = HealthInfo(
            status="ok" if writable else "degraded",
            engine_version=ENGINE_VERSION,
            ai=ai.info(),
            samples=len(list_samples()),
        )
        payload = info.model_dump(mode="json")
        payload["api_version"] = API_VERSION
        payload["data_dir_writable"] = writable
        payload["sync_pipeline"] = settings.sync_pipeline
        payload["public_runtime"] = {
            "enabled": settings.public_mode,
            "run_retention_hours": settings.run_retention_hours,
            "seed_samples": settings.seed_samples,
            "limits": {
                "uploads_per_minute": settings.uploads_per_minute,
                "ai_requests_per_hour": settings.ai_requests_per_hour,
            },
            "ai_daily_budget": daily_budget_status(ai.provider),
        }
        return payload

    @app.get("/v1/samples", response_model=list[SampleInfo])
    def samples() -> list[SampleInfo]:
        return list_samples()

    @app.get("/v1/ai/contract")
    def ai_permission_card() -> dict[str, Any]:
        return ai_contract_card(ai)

    # -- run creation -------------------------------------------------------------------

    @app.post("/v1/runs", response_model=RunCreated, status_code=202)
    async def create_run(
        file: Annotated[UploadFile, File()],
        policy: Annotated[UploadFile | None, File()] = None,
    ) -> RunCreated:
        source = await file.read(MAX_UPLOAD_BYTES + 1)
        if len(source) > MAX_UPLOAD_BYTES:
            raise APIError(
                413, "CSV_TOO_LARGE", "CSV 超过 25 MiB 上限。", "The CSV exceeds the 25 MiB limit."
            )
        if not source.strip():
            raise APIError(422, "CSV_EMPTY", "上传的 CSV 为空。", "The uploaded CSV is empty.")
        contract_yaml: str | None = None
        contract_source = ContractSource.BASELINE
        if policy is not None:
            raw = await policy.read(MAX_CONTRACT_BYTES + 1)
            if raw.strip():
                contract_yaml, _ = _parse_contract_text(raw)
                contract_source = ContractSource.UPLOADED
        return _start_run(
            ctx,
            source=source,
            source_name=file.filename or "upload.csv",
            contract_yaml=contract_yaml,
            sample_id=None,
            contract_source=contract_source,
        )

    @app.post("/v1/runs/from-sample", response_model=RunCreated, status_code=202)
    def create_run_from_sample(body: FromSampleRequest) -> RunCreated:
        try:
            sample = get_sample(body.sample_id)
        except KeyError as error:
            raise APIError(
                404,
                "SAMPLE_NOT_FOUND",
                f"样例 `{body.sample_id}` 不存在。",
                f"Sample `{body.sample_id}` does not exist.",
            ) from error
        contract_yaml = sample_contract_text(body.sample_id) if body.with_contract else None
        if contract_yaml is not None:
            parse_contract(contract_yaml)
        return _start_run(
            ctx,
            source=sample.generate(),
            source_name=f"{sample.id}.csv",
            contract_yaml=contract_yaml,
            sample_id=sample.id,
            contract_source=ContractSource.SAMPLE
            if contract_yaml is not None
            else ContractSource.BASELINE,
        )

    @app.post("/v1/runs/{run_id}/replay", status_code=202)
    def replay_run(run_id: str) -> dict[str, Any]:
        meta = _meta(ctx, run_id)
        source = store.read_source(run_id)
        contract_yaml = store.read_contract_yaml(run_id)
        stored_source = meta.get("contract_source")
        contract_source = ContractSource.BASELINE
        if contract_yaml is not None and isinstance(stored_source, str):
            try:
                contract_source = ContractSource(stored_source)
            except ValueError:
                contract_source = ContractSource.UPLOADED
        created = _start_run(
            ctx,
            source=source,
            source_name=str(meta.get("source_name") or f"{run_id}.csv"),
            contract_yaml=contract_yaml,
            sample_id=meta.get("sample_id") if isinstance(meta.get("sample_id"), str) else None,
            contract_source=contract_source,
        )
        payload = created.model_dump(mode="json")
        payload["parent_run_id"] = run_id
        return payload

    # -- run listing / detail / deletion ----------------------------------------------------

    @app.get("/v1/runs", response_model=list[RunSummary])
    def list_runs() -> list[RunSummary]:
        return store.list_runs()

    @app.delete("/v1/runs")
    def cleanup_runs(
        older_than_minutes: Annotated[int, Query(ge=0)] = 0,
    ) -> dict[str, Any]:
        cutoff = datetime.now(UTC).timestamp() - older_than_minutes * 60
        deleted = 0
        for summary in store.list_runs():
            if settings.public_mode and is_public_seed(summary.run_id):
                continue
            created = summary.created_at.replace("Z", "+00:00")
            try:
                created_ts = datetime.fromisoformat(created).timestamp()
            except ValueError:
                created_ts = 0.0
            busy = bool(pipeline.active_jobs(summary.run_id))
            if created_ts <= cutoff and not busy and store.delete(summary.run_id):
                deleted += 1
        return {"deleted": deleted}

    @app.get("/v1/runs/{run_id}", response_model=RunDetail)
    def get_run(run_id: str) -> RunDetail:
        return _run_detail(ctx, run_id)

    @app.delete("/v1/runs/{run_id}", status_code=204)
    def delete_run(run_id: str) -> Response:
        _meta(ctx, run_id)
        if pipeline.active_jobs(run_id):
            raise APIError(
                409,
                "RUN_BUSY",
                "运行仍有任务在执行，稍后再删除。",
                "The run still has a job in flight; delete it later.",
                retryable=True,
            )
        store.delete(run_id)
        return Response(status_code=204)

    # -- events ---------------------------------------------------------------------------

    @app.get("/v1/runs/{run_id}/events")
    async def run_events(
        request: Request,
        run_id: str,
        after: Annotated[int, Query(ge=0)] = 0,
        last_event_id: Annotated[str | None, Header(alias="Last-Event-ID")] = None,
    ) -> Response:
        _meta(ctx, run_id)
        if last_event_id is not None and last_event_id.isdigit():
            after = max(after, int(last_event_id))
        stream = event_stream(
            store,
            run_id,
            after,
            is_active=lambda: pipeline.is_active(run_id),
            request=request,
        )
        return sse_response(stream)

    # -- contract -------------------------------------------------------------------------

    @app.get("/v1/runs/{run_id}/contract", response_model=ContractView)
    def get_contract(run_id: str) -> ContractView:
        meta = _meta(ctx, run_id)
        return _contract_view(ctx, run_id, meta)

    @app.put("/v1/runs/{run_id}/contract", response_model=RunCreated, status_code=202)
    def put_contract(run_id: str, body: ContractPutRequest) -> RunCreated:
        meta = _meta(ctx, run_id)
        lifecycle = _lifecycle(meta)
        if lifecycle in (Lifecycle.QUEUED, Lifecycle.RUNNING) or pipeline.active_jobs(run_id):
            raise APIError(
                409,
                "RUN_BUSY",
                "运行仍在处理中，无法替换契约。",
                "The run is still processing; the contract cannot be replaced now.",
                retryable=True,
            )
        if lifecycle is Lifecycle.APPLIED or store.has(run_id, EXECUTION_FILE):
            raise APIError(
                409,
                "RUN_APPLIED",
                "已执行发布的运行是不可变审计记录；请重跑同一文件后再替换契约。",
                "An applied run is an immutable audit record; replay the file to change "
                "its contract.",
            )
        text, _contract = _parse_contract_text(body.yaml)
        draft = store.read_model(run_id, DRAFT_FILE, ContractDraftResult)
        source = (
            ContractSource.DRAFTED
            if draft is not None and draft.status == "ready"
            else ContractSource.UPLOADED
        )
        revision = int(meta.get("run_revision") or 1) + 1
        for name in REVISION_SCOPED_FILES:
            store.remove(run_id, name)
        store.write_contract_yaml(run_id, text)
        store.update_meta(
            run_id,
            run_revision=revision,
            lifecycle=Lifecycle.QUEUED.value,
            release_status=None,
            contract_source=source.value,
            error=None,
        )
        store.append_event(
            run_id,
            "CONTRACT_REPLACED",
            EventStatus.INFO,
            f"契约已替换（修订 {revision}），处置已清空，重新分析",
            f"Contract replaced (revision {revision}); decisions cleared, re-analysing",
            detail={"run_revision": revision, "contract_source": source.value},
        )
        pipeline.submit_analysis(run_id)
        return RunCreated(
            run_id=run_id, lifecycle=_lifecycle(store.read_meta(run_id)), run_revision=revision
        )

    @app.post("/v1/runs/{run_id}/contract/draft", status_code=202)
    def draft_contract(run_id: str) -> dict[str, Any]:
        _require_report(ctx, run_id)
        started = pipeline.submit_contract_draft(run_id)
        return {"status": "pending", "started": started}

    @app.get("/v1/runs/{run_id}/contract/draft", response_model=ContractDraftResult)
    def get_contract_draft(run_id: str) -> ContractDraftResult:
        _meta(ctx, run_id)
        draft = store.read_model(run_id, DRAFT_FILE, ContractDraftResult)
        if draft is None:
            if pipeline.is_job_active(run_id, "contract_draft"):
                return ContractDraftResult(
                    status="pending",
                    draft_yaml=None,
                    accepted_rules=[],
                    rejected_rules=[],
                    ledger_call_id=None,
                )
            raise APIError(
                404,
                "DRAFT_NOT_FOUND",
                "尚未请求契约草案。",
                "No contract draft has been requested for this run.",
            )
        return draft

    # -- findings -------------------------------------------------------------------------

    @app.get("/v1/runs/{run_id}/findings/{finding_id}/records")
    def finding_records(
        run_id: str,
        finding_id: str,
        limit: Annotated[int, Query(ge=1, le=100)] = 20,
    ) -> dict[str, Any]:
        _, report = _require_report(ctx, run_id)
        finding = next((f for f in report.findings if f.finding_id == finding_id), None)
        if finding is None:
            raise APIError(
                404,
                "FINDING_NOT_FOUND",
                f"发现 `{finding_id}` 不存在。",
                f"Finding `{finding_id}` does not exist.",
            )
        _, contract = _contract_of(ctx, run_id)
        return _masked_rows(store.read_source(run_id), report, contract, finding, limit)

    @app.post("/v1/runs/{run_id}/findings/{finding_id}/redteam")
    def redteam_finding(run_id: str, finding_id: str, body: RedteamBody) -> dict[str, Any]:
        """Red-team harness (spec §5.6): mutate the finding's proposal, re-run grounding.

        Nothing about the run's decision state changes; the verdict is stored under
        ``runs/<id>/redteam/<case>-<n>.json`` (never in ``report.json``) so a simulated tamper
        can never be mistaken for provenance.
        """
        _, report = _require_report(ctx, run_id)
        if body.case not in REDTEAM_CASES:
            raise APIError(
                422,
                "REDTEAM_CASE_UNKNOWN",
                f"未知的红队用例 `{body.case}`。",
                f"Unknown red-team case `{body.case}`.",
                observed=body.case,
                expected=list(REDTEAM_CASES),
            )
        finding, request = _semantic_finding(report, finding_id)
        proposal = _proposal_of(finding, request)
        verdict = ai.redteam(run_id, request, proposal, body.case)
        path, index = _next_redteam_path(store.run_dir(run_id) / REDTEAM_DIR, body.case)
        stored = {
            **verdict,
            "finding_id": finding_id,
            "run_id": run_id,
            "simulated": True,
            "sequence": index,
            "created_at": utc_now_iso(),
        }
        atomic_write_json(path, stored)
        stored["stored_as"] = f"{REDTEAM_DIR}/{path.name}"
        return stored

    @app.post("/v1/runs/{run_id}/findings/{finding_id}/semantic")
    def rerun_semantic(run_id: str, finding_id: str) -> dict[str, Any]:
        """Live re-run of the AI semantic assessment for one finding (spec §5.2b).

        Exactly one AI call is made (other semantic findings replay their stored proposal); the
        report is rewritten with the new proposal, an existing dry run is invalidated and the
        decisions are kept (minus any whose finding no longer exists).
        """
        meta, report = _require_report(ctx, run_id)
        lifecycle = _lifecycle(meta)
        if lifecycle is Lifecycle.APPLIED or store.has(run_id, EXECUTION_FILE):
            raise APIError(
                409,
                "RUN_APPLIED",
                "已执行发布的运行不能再重新评估。",
                "An applied run cannot be re-assessed.",
            )
        if pipeline.active_jobs(run_id):
            raise APIError(
                409,
                "RUN_BUSY",
                "运行仍有任务在执行，请稍后再试。",
                "The run still has a job in flight; try again shortly.",
                retryable=True,
            )
        _semantic_finding(report, finding_id)
        _, contract = _contract_of(ctx, run_id)
        revision = int(meta.get("run_revision") or 1)
        started = time.perf_counter()
        fresh = analyze_csv(
            store.read_source(run_id),
            contract,
            ai=_RerunResolver(ai.semantic_resolver(run_id), report, finding_id),
            run_revision=revision,
            run_id=run_id,
            synthetic=sample_is_synthetic(meta.get("sample_id")),
        )
        fresh = fresh.model_copy(
            update={
                "contract": fresh.contract.model_copy(update={"source": report.contract.source})
            }
        )
        store.write_json(run_id, REPORT_FILE, fresh)
        store.remove(run_id, DRY_RUN_FILE)
        store.remove(run_id, PREVIEW_FILE)
        store.remove(run_id, IDEMPOTENCY_FILE)
        present = {f.finding_id for f in fresh.findings}
        decisions = {k: v for k, v in _decisions(ctx, run_id).items() if k in present}
        store.write_json(run_id, DECISIONS_FILE, decisions)
        if lifecycle is Lifecycle.DRY_RUN_READY:
            store.update_meta(run_id, lifecycle=Lifecycle.REVIEW_REQUIRED.value)
        store.update_meta(run_id, release_status=fresh.release_status.value)
        updated = next((f for f in fresh.findings if f.finding_id == finding_id), None)
        proposal = updated.proposal if updated is not None else None
        call_id = proposal.ledger_call_id if proposal is not None else None
        provider = proposal.provider.value if proposal is not None else "none"
        elapsed = int((time.perf_counter() - started) * 1000)
        store.append_event(
            run_id,
            "SEMANTIC_ANALYSIS",
            EventStatus.INFO,
            f"已重新评估 {finding_id}（{provider}）；变更集已失效，处置保留",
            f"Re-assessed {finding_id} ({provider}); dry run invalidated, decisions kept",
            elapsed_ms=elapsed,
            detail={
                "finding_id": finding_id,
                "provider": provider,
                "model": proposal.model if proposal is not None else None,
                "ledger_call_id": call_id,
                "grounding_valid": proposal.grounding.valid if proposal is not None else None,
                "abstained": proposal.abstained if proposal is not None else None,
                "finding_present": updated is not None,
            },
        )
        return {
            "finding": updated.model_dump(mode="json") if updated is not None else None,
            "ledger_call_id": call_id,
            "run_revision": revision,
            "release_status": fresh.release_status.value,
            "unresolved": unresolved_findings(fresh, decisions),
        }

    # -- decisions / dry run / apply ------------------------------------------------------

    @app.put("/v1/runs/{run_id}/decisions")
    def put_decisions(run_id: str, body: DecisionsRequest) -> dict[str, Any]:
        meta, report = _require_report(ctx, run_id)
        if _lifecycle(meta) is Lifecycle.APPLIED or store.has(run_id, EXECUTION_FILE):
            raise APIError(
                409,
                "RUN_APPLIED",
                "已执行发布的运行不能再修改处置。",
                "Decisions cannot change after the run has been applied.",
            )
        by_id = {finding.finding_id: finding for finding in report.findings}
        revision = int(meta.get("run_revision") or 1)
        decisions = _decisions(ctx, run_id)
        for item in body.decisions:
            finding = by_id.get(item.finding_id)
            if finding is None:
                raise APIError(
                    422,
                    "FINDING_NOT_FOUND",
                    f"发现 `{item.finding_id}` 不存在于本次分析。",
                    f"Finding `{item.finding_id}` is not part of this analysis.",
                    extra={"finding_id": item.finding_id},
                )
            outcome = DecisionOutcome(item.outcome)
            if outcome not in finding.allowed_outcomes:
                raise APIError(
                    422,
                    "OUTCOME_NOT_ALLOWED",
                    f"发现 `{item.finding_id}` 不允许处置 `{outcome.value}`。",
                    f"Outcome `{outcome.value}` is not allowed for finding `{item.finding_id}`.",
                    observed=outcome.value,
                    expected=[allowed.value for allowed in finding.allowed_outcomes],
                    extra={"finding_id": item.finding_id},
                )
            decisions[item.finding_id] = HumanDecision(
                finding_id=item.finding_id,
                outcome=outcome,
                reason=item.reason,
                run_revision=revision,
            )
        store.write_json(run_id, DECISIONS_FILE, decisions)
        store.remove(run_id, DRY_RUN_FILE)
        store.remove(run_id, PREVIEW_FILE)
        store.remove(run_id, IDEMPOTENCY_FILE)
        if _lifecycle(meta) is Lifecycle.DRY_RUN_READY:
            store.update_meta(run_id, lifecycle=Lifecycle.REVIEW_REQUIRED.value)
        unresolved = unresolved_findings(report, decisions)
        return {
            "decisions": {key: value.model_dump(mode="json") for key, value in decisions.items()},
            "unresolved": unresolved,
            "run_revision": revision,
        }

    @app.post("/v1/runs/{run_id}/dry-run")
    def create_dry_run(run_id: str) -> dict[str, Any]:
        meta, report = _require_report(ctx, run_id)
        lifecycle = _lifecycle(meta)
        if lifecycle is Lifecycle.APPLIED or store.has(run_id, EXECUTION_FILE):
            raise APIError(
                409, "RUN_APPLIED", "该运行已执行发布。", "The run has already been applied."
            )
        if report.release_status is ReleaseStatus.NOT_EVALUATED:
            raise APIError(
                409,
                "NOT_EVALUATED",
                "仅观测模式：需要先提供数据契约才能生成变更集。",
                "Observational mode: a Data Contract is required before building a change set.",
            )
        decisions = _decisions(ctx, run_id)
        unresolved = unresolved_findings(report, decisions)
        if unresolved:
            raise APIError(
                409,
                "UNRESOLVED_FINDINGS",
                f"{len(unresolved)} 项发现尚未处置。",
                f"{len(unresolved)} findings are still unresolved.",
                observed=unresolved,
                expected=[],
            )
        _, contract = _contract_of(ctx, run_id)
        revision = int(meta.get("run_revision") or 1)
        dry_run = prepare_dry_run(report, list(decisions.values()), contract, run_revision=revision)
        preview = preview_changes(store.read_source(run_id), report, dry_run, 50, contract=contract)
        store.remove(run_id, IDEMPOTENCY_FILE)
        store.write_json(run_id, DRY_RUN_FILE, dry_run)
        store.write_json(run_id, PREVIEW_FILE, preview)
        store.update_meta(run_id, lifecycle=Lifecycle.DRY_RUN_READY.value)
        return {
            "dry_run": dry_run.model_dump(mode="json"),
            "preview": preview.model_dump(mode="json"),
        }

    @app.post("/v1/runs/{run_id}/apply", response_model=ExecutionResult)
    def apply_run(
        run_id: str,
        body: ApplyBody,
        response: Response,
        idempotency_header: Annotated[str | None, Header(alias="Idempotency-Key")] = None,
    ) -> ExecutionResult:
        key = body.idempotency_key or (idempotency_header or "").strip() or None
        if key is None or len(key) < 8 or len(key) > 128:
            raise APIError(
                422,
                "IDEMPOTENCY_KEY_REQUIRED",
                "需要 8–128 字符的幂等键（请求体或 Idempotency-Key 头）。",
                "An idempotency key of 8–128 characters is required "
                "(body or Idempotency-Key header).",
            )
        with ctx.apply_lock(run_id):
            meta, report = _require_report(ctx, run_id)
            existing = store.read_model(run_id, EXECUTION_FILE, ExecutionResult)
            record = _idempotency_record(ctx, run_id)
            if existing is not None:
                if record is not None and record.get("key") == key:
                    _finalize_apply(ctx, run_id, key, existing.dry_run.run_revision, existing)
                    response.headers["X-Idempotent-Replay"] = "true"
                    return existing
                raise APIError(
                    409,
                    "RUN_APPLIED",
                    "该运行已用另一个幂等键执行过发布。",
                    "The run was already applied with a different idempotency key.",
                    observed=key,
                    expected=record.get("key") if record is not None else None,
                )
            if record is not None and record.get("key") != key:
                raise APIError(
                    409,
                    "RUN_APPLIED",
                    "另一幂等键已有未完成的发布操作。",
                    "Another idempotency key already owns an unfinished apply operation.",
                    observed=key,
                    expected=record.get("key"),
                )
            dry_run = store.read_model(run_id, DRY_RUN_FILE, DryRunReport)
            if dry_run is None:
                raise APIError(
                    409,
                    "DRY_RUN_MISSING",
                    "请先生成变更集（dry run）。",
                    "Create a dry run before applying.",
                )
            revision = int(meta.get("run_revision") or 1)
            if body.run_revision != revision or dry_run.run_revision != revision:
                raise APIError(
                    409,
                    "DECISION_REVISION_MISMATCH",
                    "运行修订已变化，变更集已失效。",
                    "The run revision changed; the change set is stale.",
                    observed=body.run_revision,
                    expected=revision,
                )
            if body.approved_action_set_hash != dry_run.approved_action_set_hash:
                raise APIError(
                    409,
                    "STALE_DRY_RUN",
                    "已批准动作集哈希不一致，请重新生成变更集。",
                    "The approved action set hash does not match; rebuild the change set.",
                    observed=body.approved_action_set_hash,
                    expected=dry_run.approved_action_set_hash,
                )
            _, contract = _contract_of(ctx, run_id)
            source = store.read_source(run_id)
            bundle = execute(
                source,
                contract,
                report,
                dry_run,
                ai_call_count=store.ledger_count(run_id),
                ai_provider=ai.info().provider,
            )
            result = bundle.result
            if result.release_manifest.release_status is ReleaseStatus.BLOCKED:
                failed = [v.check_id for v in result.validations if not v.passed]
                raise APIError(
                    409,
                    "VALIDATION_FAILED",
                    f"{len(failed)} 项验证未通过，发布未发布。",
                    f"{len(failed)} validations failed; nothing was released.",
                    observed=failed,
                    expected=[],
                    extra={"execution": result.model_dump(mode="json")},
                )
            started_at = record.get("started_at") if record is not None else None
            store.write_json(
                run_id,
                IDEMPOTENCY_FILE,
                {
                    "key": key,
                    "state": "PENDING",
                    "started_at": started_at if isinstance(started_at, str) else utc_now_iso(),
                    "applied_at": None,
                    "run_revision": revision,
                    "approved_action_set_hash": dry_run.approved_action_set_hash,
                },
            )
            store.write_bytes(run_id, CANDIDATE_FILE, bundle.candidate_csv)
            store.write_bytes(run_id, RELEASE_FILE, bundle.release_csv)
            store.write_bytes(run_id, CHANGES_FILE, bundle.changes_jsonl)
            store.write_json(run_id, MANIFEST_FILE, result.release_manifest)
            store.write_json(run_id, EXECUTION_FILE, result)
            _finalize_apply(ctx, run_id, key, revision, result)
            return result

    @app.post("/v1/runs/{run_id}/tamper-test")
    def tamper_test(run_id: str) -> dict[str, Any]:
        _, report = _require_report(ctx, run_id)
        dry_run = store.read_model(run_id, DRY_RUN_FILE, DryRunReport)
        if dry_run is None:
            execution = store.read_model(run_id, EXECUTION_FILE, ExecutionResult)
            dry_run = execution.dry_run if execution is not None else None
        if dry_run is None:
            raise APIError(
                409,
                "DRY_RUN_MISSING",
                "篡改测试需要先生成变更集。",
                "The tamper test needs a dry run first.",
            )
        _, contract = _contract_of(ctx, run_id)
        tampered = _tamper(store.read_source(run_id))
        try:
            result = execute(
                tampered,
                contract,
                report,
                dry_run,
                ai_call_count=store.ledger_count(run_id),
                ai_provider=ai.info().provider,
            ).result
        except Exception as error:  # noqa: BLE001 - governance may refuse before validating
            return {
                "written": False,
                "tampered_source_hash": hashlib.sha256(tampered).hexdigest(),
                "expected_source_hash": report.profile.dataset_hash,
                "execution": None,
                "refused": {
                    "code": getattr(error, "code", type(error).__name__),
                    "message_zh": getattr(error, "message_zh", "执行在验证前即被拒绝。"),
                    "message_en": getattr(error, "message_en", str(error)),
                    "observed": getattr(error, "observed", None),
                    "expected": getattr(error, "expected", None),
                },
            }
        return {
            "written": False,
            "tampered_source_hash": hashlib.sha256(tampered).hexdigest(),
            "expected_source_hash": report.profile.dataset_hash,
            "execution": result.model_dump(mode="json"),
            "refused": None,
        }

    # -- brief / ledger -------------------------------------------------------------------

    @app.get("/v1/runs/{run_id}/brief", response_model=ReleaseBrief)
    def get_brief(run_id: str) -> ReleaseBrief:
        meta, _report = _require_report(ctx, run_id)
        brief = store.read_model(run_id, BRIEF_FILE, ReleaseBrief)
        if brief is not None and brief.status != "pending":
            return brief
        pending = ReleaseBrief(
            status="pending",
            summary_zh="",
            summary_en="",
            claims=[],
            verified_count=0,
            total_count=0,
            ledger_call_id=None,
        )
        if pipeline.is_job_active(run_id, "brief"):
            return pending
        if _lifecycle(meta) is not Lifecycle.APPLIED or not store.has(run_id, EXECUTION_FILE):
            raise APIError(
                409,
                "EXECUTION_MISSING",
                "发布简报需要先完成执行与验证。",
                "The release brief requires an executed and validated run.",
            )
        pipeline.submit_brief(run_id)
        return store.read_model(run_id, BRIEF_FILE, ReleaseBrief) or pending

    @app.get("/v1/runs/{run_id}/ai-ledger", response_model=list[AICallRecord])
    def get_ledger(run_id: str) -> list[AICallRecord]:
        _meta(ctx, run_id)
        return store.read_ledger(run_id)

    @app.get("/v1/runs/{run_id}/verify")
    def verify(run_id: str) -> dict[str, Any]:
        _meta(ctx, run_id)
        return verify_run(store.run_dir(run_id)).model_dump(mode="json")

    # -- artifacts ------------------------------------------------------------------------

    @app.get("/v1/runs/{run_id}/artifacts")
    def list_artifacts(run_id: str) -> list[dict[str, Any]]:
        _meta(ctx, run_id)
        return _artifact_listing(ctx, run_id)

    @app.get("/v1/runs/{run_id}/artifacts/{name}")
    def download_artifact(run_id: str, name: str) -> Response:
        meta = _meta(ctx, run_id)
        if name in APPLY_OUTPUT_FILES and _lifecycle(meta) is not Lifecycle.APPLIED:
            raise APIError(
                409,
                "APPLY_INCOMPLETE",
                "发布尚未完成；执行工件仍在恢复中。",
                "Apply has not completed; execution artifacts are still being recovered.",
                retryable=True,
            )
        if name == AUDIT_BUNDLE:
            bundle = _audit_bundle(ctx, run_id)
            return Response(
                content=json.dumps(bundle, ensure_ascii=False, sort_keys=True, indent=2),
                media_type="application/json",
                headers={"Content-Disposition": f'attachment; filename="{run_id}-{AUDIT_BUNDLE}"'},
            )
        media_type = DOWNLOADABLE.get(name)
        if media_type is None:
            raise APIError(
                404,
                "ARTIFACT_NOT_DOWNLOADABLE",
                f"工件 `{name}` 不可下载。",
                f"Artifact `{name}` is not downloadable.",
            )
        path = store.path(run_id, name)
        if not path.is_file():
            raise APIError(
                409,
                "ARTIFACT_NOT_READY",
                f"工件 `{name}` 尚未生成。",
                f"Artifact `{name}` has not been produced yet.",
            )
        return FileResponse(path, filename=f"{run_id}-{name}", media_type=media_type)

    # -- compatibility demo ---------------------------------------------------------------

    @app.get("/v1/demo/clinical-nlp", response_model=RunReport)
    def clinical_nlp_demo() -> RunReport:
        return _demo_release(ctx).analysis

    @app.get("/v1/demo/clinical-nlp/release", response_model=DemoRelease)
    def clinical_nlp_demo_release() -> DemoRelease:
        return _demo_release(ctx)

    return app


app = create_app()
