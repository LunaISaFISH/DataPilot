"""Data Contract drafting task (spec §5.4.2)."""

from __future__ import annotations

from dataclasses import replace
from typing import Any

from pydantic import ValidationError

from datapilot.ai.grounding import validate_contract_draft
from datapilot.ai.prompts import PROMPT_VERSION_CONTRACT_DRAFT
from datapilot.ai.redaction import build_profile_payload, strip_control
from datapilot.ai.tasks import TaskContext, fallback_result, final_status, invoke, record_call
from datapilot.contracts.models import (
    AICallRecord,
    AITask,
    ContractDraft,
    ContractDraftResult,
    GroundingResult,
    RunReport,
)
from datapilot.contracts.policy import contract_to_yaml

_NOTE_LIMIT = 300


def _comment_line(text: str) -> str:
    flat = " ".join(strip_control(text).split())
    return f"# {flat[:_NOTE_LIMIT]}"


def render_draft_yaml(
    contract_yaml: str,
    *,
    provider: str,
    model: str | None,
    input_hash: str,
    notes_zh: str,
) -> str:
    header = [
        _comment_line("AI 起草的数据契约 · 需人工确认后才会生效 / AI-drafted contract · takes "
                      "effect only after human confirmation"),
        _comment_line(
            f"provider={provider} model={model or 'n/a'} "
            f"prompt={PROMPT_VERSION_CONTRACT_DRAFT} input_hash={input_hash[:12]}"
        ),
    ]
    if notes_zh.strip():
        header.append(_comment_line(f"notes: {notes_zh}"))
    return "\n".join(header) + "\n" + contract_yaml


def _parse_draft(data: dict[str, Any] | None) -> tuple[ContractDraft | None, str | None]:
    if data is None:
        return None, None
    try:
        return ContractDraft.model_validate(data), None
    except ValidationError as exc:
        return None, f"schema violation: {exc}"[:240]


def run_contract_draft(
    ctx: TaskContext, report: RunReport
) -> tuple[ContractDraftResult, AICallRecord]:
    payload, redaction, input_hash = build_profile_payload(report)
    invocation = invoke(ctx, AITask.CONTRACT_DRAFT, payload)
    result = invocation.result
    draft, schema_error = _parse_draft(result.data if result.ok else None)
    if draft is None:
        fallback = fallback_result(ctx, AITask.CONTRACT_DRAFT, payload)
        draft = ContractDraft.model_validate(fallback.data)
        response_payload: dict[str, Any] | None = result.data if result.data else fallback.data
        provider_label = ctx.fallback.name.value
        model_label = fallback.model_served
    else:
        response_payload = result.data
        provider_label = invocation.provider.name.value
        model_label = result.model_served or invocation.provider.model

    accepted, rejected, contract = validate_contract_draft(draft, report)
    reason_codes = sorted({rule.reason_code for rule in rejected})
    if schema_error is not None:
        reason_codes = ["SCHEMA_VIOLATION", *reason_codes]
    grounding = GroundingResult(valid=not reason_codes, reason_codes=reason_codes)
    status = final_status(invocation, grounded=schema_error is None, abstained=False)

    draft_yaml = render_draft_yaml(
        contract_to_yaml(contract),
        provider=provider_label,
        model=model_label,
        input_hash=input_hash,
        notes_zh=draft.notes_zh,
    )
    if schema_error is not None:
        invocation = replace(invocation, result=replace(result, error=schema_error))
    record = record_call(
        ctx,
        task=AITask.CONTRACT_DRAFT,
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
        ContractDraftResult(
            status="ready",
            draft_yaml=draft_yaml,
            accepted_rules=accepted,
            rejected_rules=rejected,
            ledger_call_id=record.call_id,
        ),
        record,
    )
