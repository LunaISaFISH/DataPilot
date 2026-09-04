"""Public-deployment safeguards: IP rate limits, retention, and stable sample seeds."""

from __future__ import annotations

import ipaddress
import math
import re
import threading
import time
from collections import deque
from collections.abc import Awaitable, Callable, MutableMapping
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

from fastapi.responses import JSONResponse

from datapilot.api.errors import CORRELATION_HEADER, error_body, new_correlation_id
from datapilot.contracts.models import ContractSource
from datapilot.pipeline import Pipeline
from datapilot.samples import get_sample, list_samples, sample_contract_text
from datapilot.storage import RunStore

PUBLIC_SEED_PREFIX = "public-sample-"
MAINTENANCE_INTERVAL_SECONDS = 15 * 60

Scope = MutableMapping[str, Any]
Message = MutableMapping[str, Any]
Receive = Callable[[], Awaitable[Message]]
Send = Callable[[Message], Awaitable[None]]
ASGIApp = Callable[[Scope, Receive, Send], Awaitable[None]]


@dataclass(frozen=True)
class RateLimitDecision:
    allowed: bool
    retry_after: int = 0


class SlidingWindowLimiter:
    """Small in-process sliding-window limiter keyed by a privacy-neutral client address."""

    def __init__(self, limit: int, window_seconds: int) -> None:
        self.limit = max(0, limit)
        self.window_seconds = window_seconds
        self._entries: dict[str, deque[float]] = {}
        self._lock = threading.Lock()

    def check(self, key: str, *, now: float | None = None) -> RateLimitDecision:
        current = time.monotonic() if now is None else now
        cutoff = current - self.window_seconds
        with self._lock:
            entries = self._entries.setdefault(key, deque())
            while entries and entries[0] <= cutoff:
                entries.popleft()
            if len(entries) >= self.limit:
                retry_after = (
                    self.window_seconds
                    if not entries
                    else entries[0] + self.window_seconds - current
                )
                return RateLimitDecision(False, max(1, math.ceil(retry_after)))
            entries.append(current)
        return RateLimitDecision(True)


_RUN_CHILD = r"/v1/runs/[^/]+"
_AI_ENDPOINTS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("POST", re.compile(rf"^{_RUN_CHILD}/replay$")),
    ("PUT", re.compile(rf"^{_RUN_CHILD}/contract$")),
    ("POST", re.compile(rf"^{_RUN_CHILD}/contract/draft$")),
    ("POST", re.compile(rf"^{_RUN_CHILD}/findings/[^/]+/semantic$")),
    ("POST", re.compile(rf"^{_RUN_CHILD}/findings/[^/]+/redteam$")),
)


def _is_upload(method: str, path: str) -> bool:
    return method == "POST" and path in ("/v1/runs", "/v1/runs/from-sample")


def _is_ai_endpoint(method: str, path: str) -> bool:
    if _is_upload(method, path):
        return True
    return any(
        expected == method and pattern.fullmatch(path) for expected, pattern in _AI_ENDPOINTS
    )


def _header(scope: Scope, name: bytes) -> str | None:
    for raw_name, raw_value in scope.get("headers", []):
        if (
            isinstance(raw_name, bytes)
            and isinstance(raw_value, bytes)
            and raw_name.lower() == name
        ):
            return raw_value.decode("latin-1").strip()
    return None


def _valid_forwarded_address(raw: str | None) -> str | None:
    if raw is None:
        return None
    candidate = raw.split(",", 1)[0].strip()
    try:
        return ipaddress.ip_address(candidate).compressed
    except ValueError:
        return None


def client_ip(scope: Scope) -> str:
    """Trust Fly's overwritten client header only, then fall back to the ASGI peer."""
    fly_client = _valid_forwarded_address(_header(scope, b"fly-client-ip"))
    if fly_client is not None:
        return fly_client
    client = scope.get("client")
    if isinstance(client, (tuple, list)) and client and isinstance(client[0], str):
        return client[0]
    return "unknown"


class PublicRequestLimits:
    def __init__(self, uploads_per_minute: int, ai_requests_per_hour: int) -> None:
        self.uploads = SlidingWindowLimiter(uploads_per_minute, 60)
        self.ai_requests = SlidingWindowLimiter(ai_requests_per_hour, 60 * 60)

    def check(self, scope: Scope) -> tuple[str, RateLimitDecision] | None:
        method = str(scope.get("method", "GET")).upper()
        path = str(scope.get("path", ""))
        address = client_ip(scope)
        if _is_upload(method, path):
            decision = self.uploads.check(address)
            if not decision.allowed:
                return "uploads", decision
        if _is_ai_endpoint(method, path):
            decision = self.ai_requests.check(address)
            if not decision.allowed:
                return "ai_requests", decision
        return None


class PublicRateLimitMiddleware:
    def __init__(self, app: ASGIApp, *, limits: PublicRequestLimits) -> None:
        self.app = app
        self.limits = limits

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope.get("type") != "http" or str(scope.get("method", "")).upper() == "OPTIONS":
            await self.app(scope, receive, send)
            return
        limited = self.limits.check(scope)
        if limited is None:
            await self.app(scope, receive, send)
            return
        bucket, decision = limited
        state = scope.get("state")
        correlation_id = state.get("correlation_id") if isinstance(state, dict) else None
        if not isinstance(correlation_id, str):
            correlation_id = new_correlation_id()
        if bucket == "uploads":
            code = "UPLOAD_RATE_LIMIT_EXCEEDED"
            message_zh = "上传过于频繁，请稍后重试。"
            message_en = "Too many uploads; retry after the indicated delay."
        else:
            code = "AI_REQUEST_RATE_LIMIT_EXCEEDED"
            message_zh = "AI 请求过于频繁，请稍后重试。"
            message_en = "Too many AI-triggering requests; retry after the indicated delay."
        response = JSONResponse(
            status_code=429,
            content=error_body(
                code,
                message_zh,
                message_en,
                retryable=True,
                correlation_id=correlation_id,
            ),
            headers={
                CORRELATION_HEADER: correlation_id,
                "Retry-After": str(decision.retry_after),
            },
        )
        await response(scope, receive, send)


def public_seed_run_id(sample_id: str) -> str:
    return f"{PUBLIC_SEED_PREFIX}{sample_id.replace('_', '-')}"


def is_public_seed(run_id: str) -> bool:
    return run_id.startswith(PUBLIC_SEED_PREFIX)


def cleanup_expired_runs(
    store: RunStore,
    pipeline: Pipeline,
    retention_hours: int,
    *,
    now: datetime | None = None,
) -> int:
    """Delete inactive visitor runs older than retention while preserving public seeds."""
    cutoff = (now or datetime.now(UTC)) - timedelta(hours=max(0, retention_hours))
    deleted = 0
    for summary in store.list_runs():
        if is_public_seed(summary.run_id) or pipeline.active_jobs(summary.run_id):
            continue
        try:
            created_at = datetime.fromisoformat(summary.created_at.replace("Z", "+00:00"))
        except ValueError:
            continue
        if created_at <= cutoff and store.delete(summary.run_id):
            deleted += 1
    return deleted


def seed_public_samples(store: RunStore, pipeline: Pipeline) -> dict[str, int]:
    """Create one stable contracted run per bundled sample and submit missing analyses."""
    created = 0
    reused = 0
    submitted = 0
    for info in list_samples():
        sample = get_sample(info.id)
        run_id = public_seed_run_id(sample.id)
        if store.exists(run_id):
            reused += 1
        else:
            contract_yaml = sample_contract_text(sample.id)
            store.create(
                run_id,
                sample.generate(),
                f"{sample.id}.csv",
                contract_yaml,
                sample.id,
            )
            store.update_meta(run_id, contract_source=ContractSource.SAMPLE.value)
            created += 1
        if not store.has(run_id, "report.json") and pipeline.submit_analysis(run_id):
            submitted += 1
    return {"created": created, "reused": reused, "submitted": submitted}
