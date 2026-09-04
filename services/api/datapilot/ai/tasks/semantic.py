"""Semantic mapping task (spec §5.4.1): redact → call → validate → fallback → ledger."""

from __future__ import annotations

from dataclasses import dataclass, replace
from typing import Any

from pydantic import ValidationError

from datapilot.ai.grounding import validate_proposal
from datapilot.ai.prompts import PROMPT_VERSION_SEMANTIC
from datapilot.ai.provider import ProviderResult
from datapilot.ai.redaction import build_semantic_payload
from datapilot.ai.tasks import (
    Invocation,
    TaskContext,
    fallback_result,
    final_status,
    invoke,
    record_call,
)
from datapilot.contracts.models import (
    AICallRecord,
    AIProposal,
    AITask,
    GroundingResult,
    SemanticRequest,
)


@dataclass(frozen=True)
class SemanticOutcome:
    proposal: AIProposal
    grounding: GroundingResult
    record: AICallRecord
    model_proposal: AIProposal | None
    model_grounding: GroundingResult | None


def proposal_from_data(
    data: dict[str, Any],
    *,
    provider: str,
    model: str,
    input_hash: str,
) -> AIProposal:
    """Strict conversion of the model's JSON (mapping as pairs) into ``AIProposal``."""
    body = dict(data)
    pairs = body.get("mapping")
    if pairs is not None:
        if not isinstance(pairs, list):
            raise ValueError("mapping must be a list of {source, target} pairs or null")
        mapping: dict[str, str] = {}
        for pair in pairs:
            if not isinstance(pair, dict):
                raise ValueError("mapping pair must be an object")
            source = pair.get("source")
            target = pair.get("target")
            if not isinstance(source, str) or not isinstance(target, str):
                raise ValueError("mapping pair must have string source and target")
            if source in mapping:
                raise ValueError("duplicate mapping source")
            mapping[source] = target
        body["mapping"] = mapping
    body.update(
        {
            "provider": provider,
            "model": model,
            "prompt_version": PROMPT_VERSION_SEMANTIC,
            "input_hash": input_hash,
        }
    )
    return AIProposal.model_validate(body)


def _proposal_or_none(
    result: ProviderResult, invocation: Invocation, input_hash: str
) -> tuple[AIProposal | None, str | None]:
    if not result.ok or result.data is None:
        return None, None
    try:
        return (
            proposal_from_data(
                result.data,
                provider=invocation.provider.name.value,
                model=result.model_served or invocation.provider.model,
                input_hash=input_hash,
            ),
            None,
        )
    except (ValidationError, ValueError) as exc:
        return None, f"schema violation: {exc}"[:240]


def run_semantic(
    ctx: TaskContext, request: SemanticRequest, *, task: AITask = AITask.SEMANTIC
) -> SemanticOutcome:
    payload, redaction, input_hash = build_semantic_payload(request)
    invocation = invoke(ctx, task, payload)
    result = invocation.result
    model_proposal, schema_error = _proposal_or_none(result, invocation, input_hash)
    model_grounding: GroundingResult | None = None
    if model_proposal is not None:
        model_grounding = validate_proposal(request, model_proposal)
    elif schema_error is not None:
        model_grounding = GroundingResult(valid=False, reason_codes=["SCHEMA_VIOLATION"])

    if model_proposal is not None and model_grounding is not None and model_grounding.valid:
        proposal, grounding = model_proposal, model_grounding
        response_payload: dict[str, Any] | None = result.data
    else:
        fallback = fallback_result(ctx, task, payload)
        assert fallback.data is not None  # deterministic provider always answers
        proposal = proposal_from_data(
            fallback.data,
            provider=ctx.fallback.name.value,
            model=fallback.model_served or ctx.fallback.model,
            input_hash=input_hash,
        )
        grounding = validate_proposal(request, proposal)
        response_payload = result.data if result.data is not None else fallback.data

    status = final_status(
        invocation,
        grounded=model_grounding.valid if model_grounding is not None else True,
        abstained=proposal.abstained,
    )
    if schema_error is not None and result.error is None:
        invocation = replace(invocation, result=replace(result, error=schema_error))
    record = record_call(
        ctx,
        task=task,
        finding_id=request.finding_id,
        invocation=invocation,
        input_hash=input_hash,
        request_payload=payload,
        response_payload=response_payload,
        status=status,
        grounding=model_grounding if model_grounding is not None else grounding,
        redaction=redaction,
    )
    return SemanticOutcome(
        proposal=proposal,
        grounding=grounding,
        record=record,
        model_proposal=model_proposal,
        model_grounding=model_grounding,
    )

