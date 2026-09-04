"""AI call ledger — the per-run flight recorder (spec §5.5).

Backed by ``RunStore.append_ledger`` (``runs/<id>/ai-ledger.jsonl``) when a store is given and
the run exists; otherwise by an in-memory list (tests, smoke scripts, ad-hoc runs).
"""

from __future__ import annotations

import hashlib
import threading
import uuid
from typing import Any

from datapilot.ai.prompts import MAX_CALLS_PER_RUN
from datapilot.contracts.models import (
    AICallRecord,
    AIStatus,
    AITask,
    GroundingResult,
    ProviderName,
    RedactionSummary,
)
from datapilot.serialization import canonical_json
from datapilot.storage import RunStore, utc_now_iso


def output_hash(payload: dict[str, Any] | None) -> str | None:
    if payload is None:
        return None
    return hashlib.sha256(canonical_json(payload).encode("utf-8")).hexdigest()


def build_record(
    *,
    call_id: str,
    run_id: str,
    task: AITask,
    finding_id: str | None,
    provider: ProviderName,
    model_requested: str,
    model_served: str | None,
    prompt_version: str,
    input_hash: str,
    request_payload: dict[str, Any],
    response_payload: dict[str, Any] | None,
    input_tokens: int | None,
    output_tokens: int | None,
    cache_read_tokens: int | None,
    latency_ms: int,
    status: AIStatus,
    grounding: GroundingResult,
    redaction: RedactionSummary,
    request_id: str | None,
    error: str | None,
    cached_at: str | None,
) -> AICallRecord:
    return AICallRecord(
        call_id=call_id,
        run_id=run_id,
        task=task,
        provider=provider,
        model_requested=model_requested,
        model_served=model_served,
        prompt_version=prompt_version,
        input_hash=input_hash,
        output_hash=output_hash(response_payload),
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        cache_read_tokens=cache_read_tokens,
        latency_ms=max(0, latency_ms),
        status=status,
        grounding=grounding,
        redaction=redaction,
        request_id=request_id,
        created_at=utc_now_iso(),
        finding_id=finding_id,
        request_bytes=len(canonical_json(request_payload).encode("utf-8")),
        request_payload=request_payload,
        response_payload=response_payload,
        error=error,
        cached_at=cached_at,
    )


class Ledger:
    """Append-only view over the store's ledger with an in-memory fallback."""

    def __init__(self, store: RunStore | None = None) -> None:
        self.store = store
        self._memory: dict[str, list[AICallRecord]] = {}
        self._lock = threading.RLock()

    def _persisted(self, run_id: str) -> bool:
        if self.store is None:
            return False
        try:
            return self.store.exists(run_id)
        except ValueError:
            return False

    def read(self, run_id: str) -> list[AICallRecord]:
        if self._persisted(run_id) and self.store is not None:
            return self.store.read_ledger(run_id)
        with self._lock:
            return list(self._memory.get(run_id, []))

    def count(self, run_id: str) -> int:
        if self._persisted(run_id) and self.store is not None:
            return self.store.ledger_count(run_id)
        with self._lock:
            return len(self._memory.get(run_id, []))

    def live_calls(self, run_id: str) -> int:
        """Records that reached (or attempted) a live provider — what the budget bounds."""
        return sum(1 for record in self.read(run_id) if record.provider is ProviderName.ANTHROPIC)

    def budget_exhausted(self, run_id: str) -> bool:
        return self.count(run_id) >= MAX_CALLS_PER_RUN

    def new_call_id(self, run_id: str) -> str:
        return f"ai-{self.count(run_id) + 1:03d}-{uuid.uuid4().hex[:8]}"

    def append(self, record: AICallRecord) -> AICallRecord:
        if self._persisted(record.run_id) and self.store is not None:
            return self.store.append_ledger(record.run_id, record)
        with self._lock:
            self._memory.setdefault(record.run_id, []).append(record)
        return record
