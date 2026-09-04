"""Grounding validators (spec §5.4): every reason code is exercised offline."""

from __future__ import annotations

import threading
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any

import pytest
from datapilot.ai import AIRuntime, get_runtime
from datapilot.ai.grounding import (
    REDTEAM_OFFLINE_CASES,
    number_tokens,
    pattern_to_strptime,
    request_hash,
    tamper_proposal,
    validate_brief,
    validate_contract_draft,
    validate_proposal,
    verify_numbers,
)
from datapilot.ai.provider import DeterministicProvider, ProviderResult
from datapilot.ai.redaction import build_facts_payload
from datapilot.contracts.models import (
    AIProposal,
    AIStatus,
    AITask,
    ContractDraft,
    ProviderName,
    SemanticRequest,
)
from datapilot.contracts.policy import parse_contract
from pydantic import ValidationError

from tests.test_ai_redaction import CANARY, make_report, make_request


class _FailingAnthropic:
    name = ProviderName.ANTHROPIC
    model = "synthetic-live-model"

    def __init__(self, status: AIStatus) -> None:
        self.status = status

    def complete_json(
        self,
        task: AITask,
        system: str,
        user_payload: dict[str, Any],
        schema: dict[str, Any],
        *,
        effort: str,
        max_tokens: int,
        timeout_s: float,
    ) -> ProviderResult:
        return ProviderResult(
            data=None,
            status=self.status,
            model_served=None,
            input_tokens=11,
            output_tokens=0,
            cache_read_tokens=0,
            latency_ms=3,
            request_id="synthetic-request",
            error=f"synthetic {self.status.value}",
        )


class _BlockingAnthropic:
    name = ProviderName.ANTHROPIC
    model = "synthetic-live-model"

    def __init__(self) -> None:
        self.calls = 0
        self._condition = threading.Condition()
        self._release = threading.Event()
        self._deterministic = DeterministicProvider()

    def complete_json(
        self,
        task: AITask,
        system: str,
        user_payload: dict[str, Any],
        schema: dict[str, Any],
        *,
        effort: str,
        max_tokens: int,
        timeout_s: float,
    ) -> ProviderResult:
        with self._condition:
            self.calls += 1
            self._condition.notify_all()
        if not self._release.wait(timeout=5):
            raise TimeoutError("test did not release the synthetic provider")
        return self._deterministic.complete_json(
            task,
            system,
            user_payload,
            schema,
            effort=effort,
            max_tokens=max_tokens,
            timeout_s=timeout_s,
        )

    def wait_for_calls(self, count: int) -> bool:
        deadline = time.monotonic() + 5
        with self._condition:
            while self.calls < count:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return False
                self._condition.wait(remaining)
        return True

    def release(self) -> None:
        self._release.set()


def _run_ai_task(runtime: AIRuntime, run_id: str, task: AITask) -> None:
    if task is AITask.SEMANTIC:
        runtime.semantic(run_id, make_request())
    elif task is AITask.CONTRACT_DRAFT:
        runtime.draft_contract(run_id, make_report())
    else:
        runtime.brief(run_id, make_report(), None)


def grounded_proposal(request: SemanticRequest, **overrides: Any) -> AIProposal:
    body: dict[str, Any] = {
        "finding_id": request.finding_id,
        "proposed_action": "NORMALIZE_CATEGORY",
        "column": request.column,
        "mapping": {"Shang Hai": "上海", "上海 市": "上海"},
        "evidence_refs": list(request.evidence_refs),
        "semantic_explanation": "两个变体均指上海。 (Both variants denote Shanghai.)",
        "ambiguity_flags": [],
        "abstained": False,
        "abstain_reason": None,
        "provider": "anthropic",
        "model": "claude-opus-5",
        "prompt_version": "semantic-2.0",
        "input_hash": request_hash(request),
    }
    body.update(overrides)
    return AIProposal.model_validate(body)


def test_grounded_proposal_passes_and_counts_records() -> None:
    request = make_request()
    result = validate_proposal(request, grounded_proposal(request))

    assert result.valid is True
    assert result.reason_codes == []
    assert result.affected_record_count == 6


@pytest.mark.parametrize(
    ("mutation", "reason"),
    [
        ({"finding_id": "SEM-other"}, "UNKNOWN_FINDING"),
        ({"column": "province"}, "UNKNOWN_COLUMN"),
        ({"input_hash": "0" * 64}, "STALE_OR_UNKNOWN_INPUT"),
        ({"mapping": {"never seen": "上海"}}, "HALLUCINATED_SOURCE_VALUE"),
        ({"mapping": {"Shang Hai": "Shanghai City"}}, "UNKNOWN_CANONICAL_TARGET"),
        ({"evidence_refs": ["EVID-FAKE-99"]}, "UNKNOWN_EVIDENCE_REFERENCE"),
        ({"mapping": {"SZ": "深圳"}}, "AMBIGUITY_REGISTRY_HIT"),
        ({"abstained": True, "abstain_reason": "unsure"}, "ABSTENTION_WITH_MAPPING"),
    ],
)
def test_each_semantic_reason_code_is_rejected(mutation: dict[str, Any], reason: str) -> None:
    request = make_request(candidate_counts={"Shang Hai": 4, "上海 市": 2, "SZ": 12})
    result = validate_proposal(request, grounded_proposal(request, **mutation))

    assert result.valid is False
    assert reason in result.reason_codes
    assert result.affected_record_count == 0


def test_unsupported_action_is_rejected_by_the_schema() -> None:
    request = make_request()
    with pytest.raises(ValidationError):
        grounded_proposal(request, proposed_action="DELETE_ROWS")


def test_injection_canary_can_only_be_mapped_when_observed() -> None:
    request = make_request()  # canary not among candidates
    tampered = grounded_proposal(request, mapping={CANARY: "北京"})
    result = validate_proposal(request, tampered)
    assert result.valid is False
    assert "HALLUCINATED_SOURCE_VALUE" in result.reason_codes

    observed = make_request(candidate_counts={"Shang Hai": 4, CANARY: 1})
    honest = grounded_proposal(observed, mapping={"Shang Hai": "上海"})
    assert validate_proposal(observed, honest).valid is True


@pytest.mark.parametrize("case", REDTEAM_OFFLINE_CASES)
def test_redteam_mutations_trip_their_own_reason_code(case: str) -> None:
    request = make_request()
    raw = tamper_proposal(case, request, grounded_proposal(request))
    if case == "UNSUPPORTED_ACTION":
        with pytest.raises(ValidationError):
            AIProposal.model_validate(raw)
        return
    result = validate_proposal(request, AIProposal.model_validate(raw))
    assert result.valid is False
    assert case in result.reason_codes


# -- contract draft ---------------------------------------------------------------------


def draft_field(name: str, **overrides: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
        "name": name,
        "required": False,
        "unique": False,
        "type": None,
        "format": None,
        "sensitive": False,
        "allowed": [],
        "canonical": [],
        "rationale_zh": "示例理由。",
        "evidence_refs": [f"PROFILE:{name}:top_values"],
    }
    body.update(overrides)
    return body


def make_draft(*fields: dict[str, Any], **extra: Any) -> ContractDraft:
    body: dict[str, Any] = {
        "fields": list(fields),
        "business_key": [],
        "ambiguity": [],
        "notes_zh": "草稿说明。",
    }
    body.update(extra)
    return ContractDraft.model_validate(body)


def test_contract_draft_accepts_grounded_rules_and_yields_parseable_yaml() -> None:
    report = make_report()
    draft = make_draft(
        draft_field("order_id", required=True, unique=True),
        draft_field("customer_phone", sensitive=True),
        draft_field(
            "city",
            canonical=[{"target": "上海", "aliases": ["上海市", "Shanghai"]}],
            allowed=["上海", "北京"],
        ),
        draft_field("order_date", type="date", format="%Y-%m-%d"),
        draft_field("status", required=True, allowed=["paid", "shipped", "refunded", "cancelled"]),
        draft_field("amount", type="number"),
        business_key=["order_id"],
        ambiguity=[{"column": "city", "tokens": ["Shanghai"]}],
    )
    accepted, rejected, contract = validate_contract_draft(draft, report)

    assert rejected == []
    assert {(rule["field"], rule["rule"]) for rule in accepted} >= {
        ("order_id", "required"),
        ("order_id", "unique"),
        ("customer_phone", "sensitive"),
        ("city", "canonical:上海"),
        ("city", "semantic"),
        ("city", "allowed"),
        ("order_date", "format"),
        ("order_date", "accept_formats"),
        ("status", "allowed"),
        ("amount", "type"),
        ("order_id", "business_key"),
        ("city", "ambiguity"),
    }
    assert contract.fields["order_date"].accept_formats == ["%d/%m/%Y"]
    assert contract.fields["city"].semantic is True
    assert contract.business_key == ["order_id"]
    assert contract.ambiguity_registry == {"city": ["Shanghai"]}
    from datapilot.contracts.policy import contract_to_yaml

    assert parse_contract(contract_to_yaml(contract)) == contract


@pytest.mark.parametrize(
    ("field", "reason", "rule"),
    [
        (draft_field("ghost_column", required=True), "UNKNOWN_COLUMN", "field"),
        (draft_field("city", allowed=["上海", "广州"]), "UNOBSERVED_VALUE", "allowed"),
        (
            draft_field("city", canonical=[{"target": "上海", "aliases": ["沪"]}]),
            "UNOBSERVED_VALUE",
            "canonical:上海",
        ),
        (draft_field("amount", type="integer"), "TYPE_MISMATCH", "type"),
        (draft_field("customer_phone", sensitive=False), "SENSITIVE_DOWNGRADE", "sensitive"),
        (draft_field("remark", sensitive=False), "SENSITIVE_DOWNGRADE", "sensitive"),
        (
            draft_field("status", evidence_refs=["PROFILE:status:top_values", "PROFILE:city:type"]),
            "UNKNOWN_EVIDENCE",
            "evidence_refs",
        ),
        (draft_field("order_date", type="date", format="%m/%d/%Y"), "UNKNOWN_FORMAT", "format"),
    ],
)
def test_each_draft_reason_code_is_rejected(field: dict[str, Any], reason: str, rule: str) -> None:
    accepted, rejected, contract = validate_contract_draft(make_draft(field), make_report())

    assert any(item.reason_code == reason and item.rule == rule for item in rejected)
    assert all(item.detail_zh and item.detail_en for item in rejected)
    if reason == "SENSITIVE_DOWNGRADE":
        assert contract.fields[field["name"]].sensitive is True
    if reason == "UNKNOWN_COLUMN":
        assert "ghost_column" not in contract.fields
    if reason in ("UNOBSERVED_VALUE", "UNKNOWN_FORMAT"):
        rule_obj = contract.fields.get(field["name"])
        assert rule_obj is None or (
            rule_obj.allowed is None and not rule_obj.canonical and rule_obj.format is None
        )


def test_business_key_and_ambiguity_must_reference_known_columns() -> None:
    draft = make_draft(
        business_key=["order_id", "nope"],
        ambiguity=[{"column": "missing", "tokens": ["x"]}, {"column": "city", "tokens": ["ghost"]}],
    )
    _, rejected, contract = validate_contract_draft(draft, make_report())
    codes = {(item.field, item.rule, item.reason_code) for item in rejected}
    assert ("nope", "business_key", "UNKNOWN_COLUMN") in codes
    assert ("missing", "ambiguity", "UNKNOWN_COLUMN") in codes
    assert ("city", "ambiguity", "UNOBSERVED_VALUE") in codes
    assert contract.business_key == ["order_id"]
    assert contract.ambiguity_registry == {}


@pytest.mark.parametrize(
    ("pattern", "expected"),
    [
        ("YYYY-MM-DD", "%Y-%m-%d"),
        ("DD/MM/YYYY", "%d/%m/%Y"),
        ("YYYY/MM/DD", "%Y/%m/%d"),
        ("YYYY-MM-DD HH:MM:SS", "%Y-%m-%d %H:%M:%S"),
        ("YYYY-MM-DDTHH:MM:SSZ", "%Y-%m-%dT%H:%M:%SZ"),
        ("digits", None),
        ("mixed", None),
    ],
)
def test_pattern_to_strptime(pattern: str, expected: str | None) -> None:
    assert pattern_to_strptime(pattern) == expected


# -- release brief ----------------------------------------------------------------------


def test_number_tokens_handle_separators_percent_and_fullwidth() -> None:
    assert number_tokens("共 5,200 条，通过率 98.73%，另有 ５２００ 条") == [
        "5,200",
        "98.73",
        "5200",
    ]
    assert number_tokens("契约版本 1.1.0 下评估") == []


def test_brief_grounding_flags_invented_numbers_and_unknown_facts() -> None:
    payload, _, _ = build_facts_payload(make_report(), None)
    facts = payload["facts"]
    claims = validate_brief(
        [
            {
                "text_zh": "数据集共 5,200 条记录。",
                "text_en": "5200 records.",
                "fact_ids": ["record_count"],
            },
            {
                "text_zh": "综合质量分 98.73%。",
                "text_en": "Score ９８.７３.",
                "fact_ids": ["overall_score"],
            },
            {"text_zh": "共 7 个字段。", "text_en": "7 columns.", "fact_ids": ["column_count"]},
            {
                "text_zh": "隔离了 42 条记录。",
                "text_en": "42 quarantined.",
                "fact_ids": ["record_count"],
            },
            {"text_zh": "状态 NOT_EVALUATED。", "text_en": "ok", "fact_ids": ["made_up_fact"]},
            {
                "text_zh": "契约 baseline-observational 版本 1.0.0。",
                "text_en": "v1.0.0",
                "fact_ids": ["contract_version"],
            },
        ],
        facts,
    )

    assert [claim.verified for claim in claims] == [True, True, True, False, False, True]
    assert claims[3].reason is not None and "UNVERIFIED_NUMBER:42" in claims[3].reason
    assert claims[4].reason is not None and "UNKNOWN_FACT:made_up_fact" in claims[4].reason
    assert verify_numbers("98.7", facts) == ["98.7"]


# -- shared task supervision ------------------------------------------------------------


@pytest.mark.parametrize("task", [AITask.SEMANTIC, AITask.CONTRACT_DRAFT, AITask.BRIEF])
@pytest.mark.parametrize("failure", [AIStatus.REFUSAL, AIStatus.TIMEOUT, AIStatus.ERROR])
def test_provider_failure_records_the_delivered_deterministic_fallback(
    task: AITask, failure: AIStatus
) -> None:
    run_id = f"fallback-{task.value}-{failure.value}"
    runtime = get_runtime(provider=_FailingAnthropic(failure), mode="auto")

    _run_ai_task(runtime, run_id, task)

    record = runtime.ledger_records(run_id)[0]
    assert record.provider is ProviderName.DETERMINISTIC
    assert record.status is AIStatus.FALLBACK_DETERMINISTIC
    assert record.model_requested == _FailingAnthropic.model
    assert record.model_served == DeterministicProvider().model
    assert record.error is not None
    assert "attempted_provider=anthropic" in record.error
    assert f"fallback_reason={failure.value}" in record.error


def test_mixed_concurrent_tasks_cannot_overrun_the_live_call_budget() -> None:
    workers = 12
    run_id = "concurrent-mixed-budget"
    start = threading.Barrier(workers)
    provider = _BlockingAnthropic()
    runtime = get_runtime(provider=provider, mode="auto")
    tasks = [AITask.SEMANTIC, AITask.CONTRACT_DRAFT, AITask.BRIEF] * 4

    def run(task: AITask) -> None:
        start.wait(timeout=5)
        _run_ai_task(runtime, run_id, task)

    with ThreadPoolExecutor(max_workers=workers) as executor:
        futures = [executor.submit(run, task) for task in tasks]
        reached_limit = provider.wait_for_calls(8)
        time.sleep(0.1)
        calls_before_release = provider.calls
        provider.release()
        for future in futures:
            future.result(timeout=5)

    records = runtime.ledger_records(run_id)
    assert reached_limit is True
    assert calls_before_release == 8
    assert provider.calls == 8
    assert runtime.ledger.live_calls(run_id) == 8
    assert len(records) == workers
    assert {record.task for record in records} == set(tasks)
    assert sum(record.provider is ProviderName.ANTHROPIC for record in records) == 8
    assert sum(record.status is AIStatus.FALLBACK_DETERMINISTIC for record in records) == 4
