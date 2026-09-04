"""Background run pipeline and event emission (spec §6).

``Pipeline`` owns three jobs per run — analysis, contract drafting and release-brief
drafting. Each job writes its artifacts through ``RunStore``, emits ``STARTED`` /
``COMPLETED`` / ``FAILED`` events with bilingual messages, and never leaves a run in
``RUNNING`` (every failure path records a ``FAILED`` event, stores the error on ``meta.json``
and flips the lifecycle to ``FAILED``).

Execution model: a module-level ``ThreadPoolExecutor(max_workers=2)``; with
``DATAPILOT_SYNC_PIPELINE=1`` (or ``sync=True``) jobs run inline on the caller's thread.

Ordering invariant relied upon by the SSE tail: a job appends its terminal event *before* it
updates ``meta.json`` and clears its in-flight marker, so once ``Pipeline.is_active`` reports
``False`` every event of that job is already on disk.
"""

from __future__ import annotations

import logging
import os
import threading
import time
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Literal

from datapilot.ai import AIRuntime
from datapilot.contracts.models import (
    AIStatus,
    AITask,
    ContractDraftResult,
    ContractSource,
    ErrorDetail,
    EventStatus,
    ExecutionResult,
    Lifecycle,
    ReleaseBrief,
    ReleaseStatus,
    RunReport,
)
from datapilot.contracts.policy import (
    ContractError,
    DataContract,
    baseline_contract,
    parse_contract,
)
from datapilot.engine import AnalysisError, analyze_csv, parse_csv
from datapilot.samples import sample_is_synthetic
from datapilot.storage import RunStore

log = logging.getLogger("datapilot.pipeline")

JobKind = Literal["analysis", "contract_draft", "brief"]

EXECUTOR = ThreadPoolExecutor(max_workers=2, thread_name_prefix="datapilot-pipeline")

STAGE_INGESTING = "INGESTING"
STAGE_PROFILING = "PROFILING"
STAGE_DETECTING = "DETECTING"
STAGE_SENSITIVE_PREFLIGHT = "SENSITIVE_PREFLIGHT"
STAGE_SEMANTIC_ANALYSIS = "SEMANTIC_ANALYSIS"
STAGE_REVIEW_REQUIRED = "REVIEW_REQUIRED"
STAGE_OBSERVATIONAL_READY = "OBSERVATIONAL_READY"
STAGE_CONTRACT_DRAFTING = "CONTRACT_DRAFTING"
STAGE_BRIEF_DRAFTING = "BRIEF_DRAFTING"

REPORT_FILE = "report.json"
EXECUTION_FILE = "execution.json"
DRAFT_FILE = "contract-draft.json"
BRIEF_FILE = "brief.json"

_FALLBACK_STATUSES = frozenset(
    {
        AIStatus.TIMEOUT,
        AIStatus.ERROR,
        AIStatus.REFUSAL,
        AIStatus.REJECTED_BY_GROUNDING,
        AIStatus.FALLBACK_DETERMINISTIC,
    }
)


def sync_pipeline_from_env() -> bool:
    return os.environ.get("DATAPILOT_SYNC_PIPELINE", "").strip().lower() in {"1", "true", "yes"}


def _elapsed_ms(started: float) -> int:
    return max(0, int((time.perf_counter() - started) * 1000))


def _error_detail(code: str, message_zh: str, message_en: str, *, retryable: bool) -> ErrorDetail:
    return ErrorDetail(
        code=code,
        message_zh=message_zh,
        message_en=message_en,
        retryable=retryable,
        correlation_id=os.urandom(16).hex(),
    )


def _classify(error: Exception) -> ErrorDetail:
    """Map any exception raised inside a job to a bilingual ``ErrorDetail``."""
    if isinstance(error, AnalysisError):
        code = getattr(error, "code", None)
        return _error_detail(
            code if isinstance(code, str) and code else "CSV_INVALID",
            _str_attr(error, "message_zh", "CSV 无法分析。"),
            _str_attr(error, "message_en", str(error)),
            retryable=False,
        )
    if isinstance(error, ContractError):
        return _error_detail(error.code, error.message_zh, error.message_en, retryable=False)
    return _error_detail(
        "INTERNAL",
        "流水线内部错误，请查看服务器日志。",
        f"Internal pipeline error: {type(error).__name__}.",
        retryable=True,
    )


def _str_attr(obj: object, name: str, default: str) -> str:
    value = getattr(obj, name, None)
    return value if isinstance(value, str) and value else default


def _is_semantic_finding(finding_id: str) -> bool:
    return finding_id.startswith("SEM-") and not finding_id.endswith("-CONFLICT")


class Pipeline:
    """Runs the per-run jobs and tracks which ones are in flight."""

    def __init__(
        self,
        store: RunStore,
        ai: AIRuntime,
        *,
        sync: bool | None = None,
        executor: ThreadPoolExecutor | None = None,
    ) -> None:
        self.store = store
        self.ai = ai
        self.sync = sync_pipeline_from_env() if sync is None else sync
        self.executor = executor or EXECUTOR
        self._active: set[tuple[str, JobKind]] = set()
        self._lock = threading.Lock()

    # -- scheduling ---------------------------------------------------------------------

    def active_jobs(self, run_id: str) -> set[str]:
        with self._lock:
            return {kind for rid, kind in self._active if rid == run_id}

    def is_job_active(self, run_id: str, kind: JobKind) -> bool:
        with self._lock:
            return (run_id, kind) in self._active

    def is_active(self, run_id: str) -> bool:
        """True while the run can still emit events (lifecycle or in-flight job)."""
        if self.active_jobs(run_id):
            return True
        try:
            lifecycle = self.store.read_meta(run_id).get("lifecycle")
        except (OSError, ValueError):
            return False
        return lifecycle in (Lifecycle.QUEUED.value, Lifecycle.RUNNING.value)

    def submit(self, run_id: str, kind: JobKind) -> bool:
        """Schedule a job; returns ``False`` when the same job is already in flight."""
        with self._lock:
            key = (run_id, kind)
            if key in self._active:
                return False
            self._active.add(key)
        job = self._job(kind)
        if self.sync:
            self._run_job(run_id, kind, job)
        else:
            self.executor.submit(self._run_job, run_id, kind, job)
        return True

    def submit_analysis(self, run_id: str) -> bool:
        return self.submit(run_id, "analysis")

    def submit_contract_draft(self, run_id: str) -> bool:
        return self.submit(run_id, "contract_draft")

    def submit_brief(self, run_id: str) -> bool:
        return self.submit(run_id, "brief")

    def _job(self, kind: JobKind) -> Callable[[str], None]:
        if kind == "analysis":
            return self.run_analysis
        if kind == "contract_draft":
            return self.run_contract_draft
        return self.run_brief

    def _run_job(self, run_id: str, kind: JobKind, job: Callable[[str], None]) -> None:
        try:
            job(run_id)
        except Exception:  # pragma: no cover - jobs handle their own failures
            log.exception("pipeline job %s crashed for run %s", kind, run_id)
        finally:
            with self._lock:
                self._active.discard((run_id, kind))

    # -- helpers ------------------------------------------------------------------------

    def _emit(
        self,
        run_id: str,
        stage: str,
        status: EventStatus,
        message_zh: str,
        message_en: str,
        *,
        elapsed_ms: int | None = None,
        detail: dict[str, Any] | None = None,
    ) -> None:
        self.store.append_event(
            run_id,
            stage,
            status,
            message_zh,
            message_en,
            elapsed_ms=elapsed_ms,
            detail=detail,
        )

    def _fail(
        self,
        run_id: str,
        stage: str,
        error: Exception,
        started: float,
        *,
        lifecycle: Lifecycle | None,
    ) -> ErrorDetail:
        detail = _classify(error)
        if detail.code == "INTERNAL":
            log.exception("run %s failed at %s", run_id, stage)
        else:
            log.warning("run %s failed at %s: %s", run_id, stage, detail.code)
        self._emit(
            run_id,
            stage,
            EventStatus.FAILED,
            detail.message_zh,
            detail.message_en,
            elapsed_ms=_elapsed_ms(started),
            detail={"code": detail.code, "retryable": detail.retryable},
        )
        if lifecycle is not None:
            # Only the analysis job owns the run lifecycle; draft/brief failures live in
            # their own artifacts and never mark an analysed run as failed.
            self.store.update_meta(
                run_id, lifecycle=lifecycle.value, error=detail.model_dump(mode="json")
            )
        return detail

    def _load_contract(self, run_id: str) -> DataContract:
        text = self.store.read_contract_yaml(run_id)
        if text is None:
            return baseline_contract()
        return parse_contract(text)

    def _contract_source(self, run_id: str, contract: DataContract) -> ContractSource:
        stored = self.store.read_meta(run_id).get("contract_source")
        if isinstance(stored, str):
            try:
                return ContractSource(stored)
            except ValueError:
                pass
        return ContractSource.BASELINE if contract.is_observational else ContractSource.UPLOADED

    def _semantic_detail(self, run_id: str, report: RunReport) -> dict[str, Any]:
        info = self.ai.info()
        sem_columns = sorted(
            {
                finding.column
                for finding in report.findings
                if finding.column is not None and _is_semantic_finding(finding.finding_id)
            }
        )
        proposals = [
            finding.proposal
            for finding in report.findings
            if _is_semantic_finding(finding.finding_id) and finding.proposal is not None
        ]
        ledger = [
            record for record in self.store.read_ledger(run_id) if record.task == AITask.SEMANTIC
        ]
        detail: dict[str, Any] = {
            "sem_columns": sem_columns,
            "provider": info.provider.value,
            "model": info.model,
            "proposals": sum(1 for p in proposals if not p.abstained and p.grounding.valid),
            "abstained": sum(1 for p in proposals if p.abstained),
            "rejected": sum(1 for p in proposals if not p.abstained and not p.grounding.valid),
            "ledger_call_ids": [record.call_id for record in ledger],
        }
        if ledger:
            served = [record.model_served for record in ledger if record.model_served]
            if served:
                detail["model"] = served[-1]
            detail["provider"] = ledger[-1].provider.value
        fallback_reason: str | None = None
        if not info.available:
            fallback_reason = f"provider_unavailable:{info.mode}"
        else:
            degraded = [
                record.status.value for record in ledger if record.status in _FALLBACK_STATUSES
            ]
            if degraded:
                fallback_reason = degraded[-1]
        if fallback_reason is not None:
            detail["fallback_reason"] = fallback_reason
        return detail

    # -- jobs ---------------------------------------------------------------------------

    def run_analysis(self, run_id: str) -> None:
        """INGESTING → PROFILING → DETECTING → SENSITIVE_PREFLIGHT → SEMANTIC_ANALYSIS →
        REVIEW_REQUIRED | OBSERVATIONAL_READY."""
        started = time.perf_counter()
        stage = STAGE_INGESTING
        meta = self.store.update_meta(run_id, lifecycle=Lifecycle.RUNNING.value, error=None)
        revision_raw = meta.get("run_revision")
        run_revision = revision_raw if isinstance(revision_raw, int) and revision_raw >= 1 else 1
        try:
            self._emit(
                run_id,
                STAGE_INGESTING,
                EventStatus.STARTED,
                "读取源文件并校验 CSV 结构",
                "Reading the source file and validating CSV structure",
            )
            source = self.store.read_source(run_id)
            contract = self._load_contract(run_id)
            parsed = parse_csv(source)
            encoding = parsed.encoding
            rows, columns = parsed.frame.height, parsed.frame.width
            self._emit(
                run_id,
                STAGE_INGESTING,
                EventStatus.COMPLETED,
                f"已接收 {rows:,} 条记录、{columns} 个字段（{encoding}）",
                f"Received {rows:,} records and {columns} columns ({encoding})",
                elapsed_ms=_elapsed_ms(started),
                detail={
                    "rows": rows,
                    "columns": columns,
                    "bytes": len(source),
                    "encoding": encoding,
                    "contract_id": contract.id,
                    "contract_fields": contract.field_count,
                },
            )

            stage = STAGE_PROFILING
            profiling_started = time.perf_counter()
            self._emit(
                run_id,
                STAGE_PROFILING,
                EventStatus.STARTED,
                "计算字段画像与质量分",
                "Computing column profiles and quality metrics",
            )
            report = analyze_csv(
                source,
                contract,
                ai=self.ai.semantic_resolver(run_id),
                run_revision=run_revision,
                run_id=run_id,
                synthetic=sample_is_synthetic(meta.get("sample_id")),
            )
            source_kind = self._contract_source(run_id, contract)
            if report.contract.source != source_kind:
                report = report.model_copy(
                    update={"contract": report.contract.model_copy(update={"source": source_kind})}
                )
            self.store.write_json(run_id, REPORT_FILE, report)
            timings = report.timings_ms
            self._emit(
                run_id,
                STAGE_PROFILING,
                EventStatus.COMPLETED,
                f"已画像 {report.profile.column_count} 个字段",
                f"Profiled {report.profile.column_count} columns",
                elapsed_ms=timings.get("profile", _elapsed_ms(profiling_started)),
                detail={
                    "columns": report.profile.column_count,
                    "overall_score": report.profile.overall_score,
                    "score_version": report.profile.score_version,
                    "applicable_metrics": [m.name for m in report.profile.metrics if m.applicable],
                },
            )

            stage = STAGE_DETECTING
            by_risk: dict[str, int] = {}
            for finding in report.findings:
                by_risk[finding.risk_level.value] = by_risk.get(finding.risk_level.value, 0) + 1
            self._emit(
                run_id,
                STAGE_DETECTING,
                EventStatus.STARTED,
                "运行契约驱动的检测器",
                "Running contract-driven detectors",
            )
            self._emit(
                run_id,
                STAGE_DETECTING,
                EventStatus.COMPLETED,
                f"检出 {len(report.findings)} 项发现",
                f"Detected {len(report.findings)} findings",
                elapsed_ms=timings.get("detect"),
                detail={
                    "findings": len(report.findings),
                    "by_risk": by_risk,
                    "blocking": sum(1 for f in report.findings if f.blocking),
                    "warnings": len(report.warnings_en),
                },
            )

            stage = STAGE_SENSITIVE_PREFLIGHT
            preflight = report.sensitive_preflight
            withheld = len(preflight.columns_withheld)
            self._emit(
                run_id,
                STAGE_SENSITIVE_PREFLIGHT,
                EventStatus.STARTED,
                "扫描敏感模式并遮蔽",
                "Scanning sensitive patterns and masking",
            )
            self._emit(
                run_id,
                STAGE_SENSITIVE_PREFLIGHT,
                EventStatus.COMPLETED,
                f"已遮蔽 {preflight.cells_masked:,} 个单元格，{withheld} 列不送模型",
                f"Masked {preflight.cells_masked:,} cells; {withheld} columns withheld "
                "from the model",
                elapsed_ms=0,
                detail={
                    "columns_withheld": list(preflight.columns_withheld),
                    "cells_masked": preflight.cells_masked,
                },
            )

            stage = STAGE_SEMANTIC_ANALYSIS
            semantic_detail = self._semantic_detail(run_id, report)
            self._emit(
                run_id,
                STAGE_SEMANTIC_ANALYSIS,
                EventStatus.STARTED,
                "评估语义映射提议",
                "Evaluating semantic mapping proposals",
            )
            if "fallback_reason" in semantic_detail:
                reason = semantic_detail["fallback_reason"]
                message_zh = f"AI 不可用 → 已降级为确定性回退（{reason}）"
                message_en = f"AI unavailable → deterministic fallback ({reason})"
            elif semantic_detail["sem_columns"]:
                message_zh = (
                    f"{len(semantic_detail['sem_columns'])} 列已评估，"
                    f"{semantic_detail['proposals']} 项提议通过接地校验"
                )
                message_en = (
                    f"{len(semantic_detail['sem_columns'])} columns evaluated, "
                    f"{semantic_detail['proposals']} proposals passed grounding"
                )
            else:
                message_zh = "无需语义评估的列"
                message_en = "No columns require semantic evaluation"
            self._emit(
                run_id,
                STAGE_SEMANTIC_ANALYSIS,
                EventStatus.COMPLETED,
                message_zh,
                message_en,
                elapsed_ms=timings.get("semantic"),
                detail=semantic_detail,
            )

            observational = report.release_status is ReleaseStatus.NOT_EVALUATED
            terminal_stage = STAGE_OBSERVATIONAL_READY if observational else STAGE_REVIEW_REQUIRED
            lifecycle = Lifecycle.OBSERVATIONAL if observational else Lifecycle.REVIEW_REQUIRED
            stage = terminal_stage
            total_ms = _elapsed_ms(started)
            if observational:
                message_zh = "仅观测模式：未提供契约，发布状态不评估"
                message_en = "Observational mode: no contract, release status not evaluated"
            else:
                blocking = sum(1 for f in report.findings if f.blocking)
                status_value = report.release_status.value
                message_zh = f"等待人工处置：{blocking} 项阻断发现，发布状态 {status_value}"
                message_en = (
                    f"Awaiting human review: {blocking} blocking findings, "
                    f"release status {report.release_status.value}"
                )
            self._emit(
                run_id,
                terminal_stage,
                EventStatus.COMPLETED,
                message_zh,
                message_en,
                elapsed_ms=total_ms,
                detail={
                    "release_status": report.release_status.value,
                    "findings": len(report.findings),
                    "run_revision": run_revision,
                    "total_ms": total_ms,
                },
            )
            self.store.update_meta(
                run_id,
                lifecycle=lifecycle.value,
                record_count=report.profile.record_count,
                column_count=report.profile.column_count,
                release_status=report.release_status.value,
                contract_source=source_kind.value,
                error=None,
            )
        except Exception as error:  # noqa: BLE001 - every failure must land in FAILED
            self._fail(run_id, stage, error, started, lifecycle=Lifecycle.FAILED)

    def run_contract_draft(self, run_id: str) -> None:
        """CONTRACT_DRAFTING: AI drafts a Data Contract from redacted profiles."""
        started = time.perf_counter()
        self.store.write_json(
            run_id,
            DRAFT_FILE,
            ContractDraftResult(
                status="pending",
                draft_yaml=None,
                accepted_rules=[],
                rejected_rules=[],
                ledger_call_id=None,
            ),
        )
        self._emit(
            run_id,
            STAGE_CONTRACT_DRAFTING,
            EventStatus.STARTED,
            "AI 正在根据脱敏画像起草契约",
            "AI is drafting a contract from redacted profiles",
        )
        try:
            report = self.store.read_model(run_id, REPORT_FILE, RunReport)
            if report is None:
                raise RuntimeError("report.json is required before drafting a contract")
            result = self.ai.draft_contract(run_id, report)
            self.store.write_json(run_id, DRAFT_FILE, result)
            status = EventStatus.COMPLETED if result.status == "ready" else EventStatus.FAILED
            self._emit(
                run_id,
                STAGE_CONTRACT_DRAFTING,
                status,
                (
                    f"契约草案就绪：采纳 {len(result.accepted_rules)} 条规则，"
                    f"拦下 {len(result.rejected_rules)} 条"
                    if result.status == "ready"
                    else "契约起草失败"
                ),
                (
                    f"Contract draft ready: {len(result.accepted_rules)} rules accepted, "
                    f"{len(result.rejected_rules)} rejected"
                    if result.status == "ready"
                    else "Contract drafting failed"
                ),
                elapsed_ms=_elapsed_ms(started),
                detail={
                    "status": result.status,
                    "accepted": len(result.accepted_rules),
                    "rejected": len(result.rejected_rules),
                    "ledger_call_id": result.ledger_call_id,
                    "error_code": result.error.code if result.error is not None else None,
                },
            )
        except Exception as error:  # noqa: BLE001
            detail = self._fail(run_id, STAGE_CONTRACT_DRAFTING, error, started, lifecycle=None)
            self.store.write_json(
                run_id,
                DRAFT_FILE,
                ContractDraftResult(
                    status="failed",
                    draft_yaml=None,
                    accepted_rules=[],
                    rejected_rules=[],
                    ledger_call_id=None,
                    error=detail,
                ),
            )

    def run_brief(self, run_id: str) -> None:
        """BRIEF_DRAFTING: AI narrates the release from named facts; never changes state."""
        started = time.perf_counter()
        self._emit(
            run_id,
            STAGE_BRIEF_DRAFTING,
            EventStatus.STARTED,
            "AI 正在根据命名事实撰写发布简报",
            "AI is drafting the release brief from named facts",
        )
        try:
            report = self.store.read_model(run_id, REPORT_FILE, RunReport)
            execution = self.store.read_model(run_id, EXECUTION_FILE, ExecutionResult)
            if report is None or execution is None:
                raise RuntimeError("report.json and execution.json are required for a brief")
            brief = self.ai.brief(run_id, report, execution)
            self.store.write_json(run_id, BRIEF_FILE, brief)
            status = EventStatus.COMPLETED if brief.status == "ready" else EventStatus.FAILED
            self._emit(
                run_id,
                STAGE_BRIEF_DRAFTING,
                status,
                f"发布简报就绪：{brief.verified_count}/{brief.total_count} 条陈述通过数值核验"
                if brief.status == "ready"
                else "发布简报生成失败",
                f"Release brief ready: {brief.verified_count}/{brief.total_count} claims verified"
                if brief.status == "ready"
                else "Release brief generation failed",
                elapsed_ms=_elapsed_ms(started),
                detail={
                    "status": brief.status,
                    "verified_count": brief.verified_count,
                    "total_count": brief.total_count,
                    "ledger_call_id": brief.ledger_call_id,
                },
            )
        except Exception as error:  # noqa: BLE001
            detail = self._fail(run_id, STAGE_BRIEF_DRAFTING, error, started, lifecycle=None)
            self.store.write_json(
                run_id,
                BRIEF_FILE,
                ReleaseBrief(
                    status="failed",
                    summary_zh=detail.message_zh,
                    summary_en=detail.message_en,
                    claims=[],
                    verified_count=0,
                    total_count=0,
                    ledger_call_id=None,
                ),
            )


__all__ = [
    "EXECUTOR",
    "JobKind",
    "Pipeline",
    "STAGE_BRIEF_DRAFTING",
    "STAGE_CONTRACT_DRAFTING",
    "STAGE_DETECTING",
    "STAGE_INGESTING",
    "STAGE_OBSERVATIONAL_READY",
    "STAGE_PROFILING",
    "STAGE_REVIEW_REQUIRED",
    "STAGE_SEMANTIC_ANALYSIS",
    "STAGE_SENSITIVE_PREFLIGHT",
    "sync_pipeline_from_env",
]
