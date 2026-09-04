"""Shared plumbing for the three bounded AI tasks: budget, provider dispatch, ledger records."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from datapilot.ai.ledger import Ledger, build_record
from datapilot.ai.prompts import (
    EFFORT,
    MAX_TOKENS,
    OUTPUT_SCHEMAS,
    PROMPT_VERSIONS,
    SYSTEM_PROMPTS,
    TIMEOUT_SECONDS,
)
from datapilot.ai.provider import DeterministicProvider, LLMProvider, ProviderResult
from datapilot.contracts.models import (
    AICallRecord,
    AIStatus,
    AITask,
    GroundingResult,
    ProviderName,
    RedactionSummary,
)

BUDGET_EXCEEDED = "AI_CALL_BUDGET_EXCEEDED"


@dataclass
class TaskContext:
    run_id: str
    provider: LLMProvider
    ledger: Ledger
    fallback: DeterministicProvider


@dataclass(frozen=True)
class Invocation:
    result: ProviderResult
    provider: LLMProvider
    note: str | None

    @property
    def deterministic(self) -> bool:
        return self.provider.name is not ProviderName.ANTHROPIC


def invoke(ctx: TaskContext, task: AITask, payload: dict[str, Any]) -> Invocation:
    """Call the configured provider unless the per-run budget is exhausted (spec §5.5)."""
    provider: LLMProvider = ctx.provider
    note: str | None = None
    live_reserved = False
    if provider.name is ProviderName.ANTHROPIC:
        live_reserved = ctx.ledger.try_reserve_live_call(ctx.run_id)
        if not live_reserved:
            provider = ctx.fallback
            note = BUDGET_EXCEEDED
    prompt_task = AITask.SEMANTIC if task is AITask.REDTEAM else task
    try:
        result = provider.complete_json(
            prompt_task,
            SYSTEM_PROMPTS[prompt_task],
            payload,
            OUTPUT_SCHEMAS[prompt_task],
            effort=EFFORT[prompt_task],
            max_tokens=MAX_TOKENS[prompt_task],
            timeout_s=TIMEOUT_SECONDS[prompt_task],
        )
    finally:
        if live_reserved:
            ctx.ledger.finish_live_call(ctx.run_id)
    return Invocation(result=result, provider=provider, note=note)


def fallback_result(ctx: TaskContext, task: AITask, payload: dict[str, Any]) -> ProviderResult:
    prompt_task = AITask.SEMANTIC if task is AITask.REDTEAM else task
    return ctx.fallback.complete_json(
        prompt_task,
        SYSTEM_PROMPTS[prompt_task],
        payload,
        OUTPUT_SCHEMAS[prompt_task],
        effort=EFFORT[prompt_task],
        max_tokens=MAX_TOKENS[prompt_task],
        timeout_s=TIMEOUT_SECONDS[prompt_task],
    )


def final_status(invocation: Invocation, *, grounded: bool, abstained: bool) -> AIStatus:
    """Ledger status for one task invocation (never labels deterministic work as AI)."""
    result = invocation.result
    if result.status in (AIStatus.REFUSAL, AIStatus.TIMEOUT, AIStatus.ERROR):
        return AIStatus.FALLBACK_DETERMINISTIC
    if invocation.deterministic:
        return AIStatus.FALLBACK_DETERMINISTIC
    if not result.ok:
        return result.status
    if not grounded:
        return AIStatus.REJECTED_BY_GROUNDING
    if abstained:
        return AIStatus.ABSTAINED
    return result.status  # OK or CACHED


def record_call(
    ctx: TaskContext,
    *,
    task: AITask,
    finding_id: str | None,
    invocation: Invocation,
    input_hash: str,
    request_payload: dict[str, Any],
    response_payload: dict[str, Any] | None,
    status: AIStatus,
    grounding: GroundingResult,
    redaction: RedactionSummary,
) -> AICallRecord:
    result = invocation.result
    prompt_task = AITask.SEMANTIC if task is AITask.REDTEAM else task
    delivered_by_fallback = status is AIStatus.FALLBACK_DETERMINISTIC
    provider = ctx.fallback if delivered_by_fallback else invocation.provider
    model_served = ctx.fallback.model if delivered_by_fallback else result.model_served
    error_parts: list[str] = []
    if delivered_by_fallback and not invocation.deterministic:
        error_parts.extend(
            (
                f"attempted_provider={invocation.provider.name.value}",
                f"fallback_reason={result.status.value}",
            )
        )
    elif invocation.note is not None:
        error_parts.append(f"fallback_reason={invocation.note}")
    if result.error:
        error_parts.append(result.error)
    if invocation.note and invocation.note not in " ".join(error_parts):
        error_parts.append(invocation.note)
    record = build_record(
        call_id=ctx.ledger.new_call_id(ctx.run_id),
        run_id=ctx.run_id,
        task=task,
        finding_id=finding_id,
        provider=provider.name,
        model_requested=invocation.provider.model,
        model_served=model_served,
        prompt_version=PROMPT_VERSIONS[prompt_task],
        input_hash=input_hash,
        request_payload=request_payload,
        response_payload=response_payload,
        input_tokens=result.input_tokens,
        output_tokens=result.output_tokens,
        cache_read_tokens=result.cache_read_tokens,
        latency_ms=result.latency_ms,
        status=status,
        grounding=grounding,
        redaction=redaction,
        request_id=result.request_id,
        error="; ".join(error_parts) if error_parts else None,
        cached_at=result.cached_at,
    )
    return ctx.ledger.append(record)
