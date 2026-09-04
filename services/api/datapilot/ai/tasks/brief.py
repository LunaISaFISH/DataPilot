"""Release brief narration task (spec §5.4.3). Never changes engine state."""

from __future__ import annotations

from typing import Any

from datapilot.ai.grounding import validate_brief
from datapilot.ai.redaction import build_facts_payload
from datapilot.ai.tasks import TaskContext, fallback_result, final_status, invoke, record_call
from datapilot.contracts.models import (
    AICallRecord,
    AITask,
    ExecutionResult,
    GroundingResult,
    ReleaseBrief,
    RunReport,
)


def _parse_brief(data: dict[str, Any] | None) -> tuple[str, str, list[dict[str, Any]]] | None:
    if data is None:
        return None
    summary_zh = data.get("summary_zh")
    summary_en = data.get("summary_en")
    claims = data.get("claims")
    if not isinstance(summary_zh, str) or not isinstance(summary_en, str):
        return None
    if not isinstance(claims, list) or not all(isinstance(item, dict) for item in claims):
        return None
    return summary_zh, summary_en, [dict(item) for item in claims]


def run_brief(
    ctx: TaskContext, report: RunReport, execution: ExecutionResult | None
) -> tuple[ReleaseBrief, AICallRecord]:
    payload, redaction, input_hash = build_facts_payload(
        report, execution, ai_call_count=ctx.ledger.count(ctx.run_id)
    )
    facts: dict[str, Any] = payload["facts"]
    invocation = invoke(ctx, AITask.BRIEF, payload)
    result = invocation.result
    parsed = _parse_brief(result.data if result.ok else None)
    schema_failed = result.ok and parsed is None
    if parsed is None:
        fallback = fallback_result(ctx, AITask.BRIEF, payload)
        parsed = _parse_brief(fallback.data)
        assert parsed is not None  # the deterministic template always parses
        response_payload: dict[str, Any] | None = result.data if result.data else fallback.data
    else:
        response_payload = result.data
    summary_zh, summary_en, raw_claims = parsed
    claims = validate_brief(raw_claims, facts)
    verified = sum(1 for claim in claims if claim.verified)
    reason_codes = sorted(
        {
            reason.split(":", 1)[0]
            for claim in claims
            if claim.reason
            for reason in claim.reason.split("; ")
        }
    )
    if schema_failed:
        reason_codes = ["SCHEMA_VIOLATION", *reason_codes]
    grounding = GroundingResult(valid=not reason_codes, reason_codes=reason_codes)
    status = final_status(invocation, grounded=not schema_failed, abstained=False)
    record = record_call(
        ctx,
        task=AITask.BRIEF,
        finding_id=None,
        invocation=invocation,
        input_hash=input_hash,
        request_payload=payload,
        response_payload=response_payload,
        status=status,
        grounding=grounding,
        redaction=redaction,
    )
    return (
        ReleaseBrief(
            status="ready",
            summary_zh=summary_zh,
            summary_en=summary_en,
            claims=claims,
            verified_count=verified,
            total_count=len(claims),
            ledger_call_id=record.call_id,
        ),
        record,
    )
