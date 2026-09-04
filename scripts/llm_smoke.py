"""Live smoke check for the AI layer (spec §5.2, §10).

Runs one real semantic call and one real contract-draft call against the configured provider
with ``DATAPILOT_AI_MODE=auto`` and prints status, model, tokens, latency and grounding.
Exits non-zero when the provider is not the live Anthropic provider, when a call fails, or when
the semantic result is not grounded. Never prints credentials.
"""

from __future__ import annotations

import os
import sys

from datapilot.ai import get_runtime
from datapilot.contracts.models import (
    AIStatus,
    ColumnProfile,
    ContractInfo,
    ContractSource,
    FormatPattern,
    MetricScore,
    ProfileSummary,
    ProviderName,
    ReleaseStatus,
    RunReport,
    SemanticRequest,
    SensitivePreflight,
    TopValue,
)

LIVE_STATUSES = {AIStatus.OK, AIStatus.ABSTAINED, AIStatus.CACHED}
ROWS = 1200


def _column(
    name: str,
    inferred_type: str,
    top: list[tuple[str, int]],
    distinct: int,
    *,
    nulls: int = 0,
    patterns: list[tuple[str, int]] | None = None,
    sensitive_hits: int = 0,
) -> ColumnProfile:
    return ColumnProfile.model_validate(
        {
            "name": name,
            "inferred_type": inferred_type,
            "null_count": nulls,
            "null_rate": nulls / ROWS,
            "distinct_count": distinct,
            "top_values": [TopValue(value=value, count=count) for value, count in top],
            "min": None,
            "max": None,
            "max_length": max((len(value) for value, _ in top), default=0),
            "format_patterns": [
                FormatPattern(pattern=pattern, count=count) for pattern, count in patterns or []
            ],
            "sensitive_hit_count": sensitive_hits,
            "contract_flags": [],
        }
    )


def make_smoke_report() -> RunReport:
    """A tiny inline profile: enough for the model to draft a few rules, nothing sensitive."""
    columns = [
        _column("order_id", "string", [("ORD-000001", 1), ("ORD-000002", 1)], ROWS),
        _column(
            "city",
            "string",
            [("上海", 600), ("上海市", 90), ("Shanghai", 40), ("北京", 400), ("深圳", 70)],
            5,
        ),
        _column(
            "order_date",
            "date",
            [("2026-03-01", 20), ("02/03/2026", 8)],
            240,
            patterns=[("YYYY-MM-DD", 1100), ("DD/MM/YYYY", 100)],
        ),
        _column(
            "status", "string", [("paid", 700), ("shipped", 400), ("refunded", 90)], 3, nulls=10
        ),
        _column("customer_phone", "string", [("13800138000", 2)], 1150, sensitive_hits=1190),
    ]
    metrics = [
        MetricScore(
            name=name,
            numerator=1,
            denominator=1,
            score=100.0,
            scope_zh="观测",
            scope_en="observational",
            applicable=True,
        )
        for name in ("completeness", "validity", "uniqueness")
    ]
    return RunReport(
        schema_version="2.0",
        engine_version="0.2.0",
        fixture_version=None,
        synthetic=True,
        profile=ProfileSummary(
            dataset_hash="0" * 64,
            record_count=ROWS,
            column_count=len(columns),
            scope_hash="1" * 64,
            evaluation_scope_hash="2" * 64,
            score_version="dq-1.0",
            metrics=metrics,
            overall_score=100.0,
        ),
        column_profiles=columns,
        contract=ContractInfo(
            id="baseline-observational",
            version="1.0.0",
            hash="3" * 64,
            source=ContractSource.BASELINE,
            field_count=0,
        ),
        sensitive_preflight=SensitivePreflight(columns_withheld=["customer_phone"], cells_masked=2),
        findings=[],
        release_status=ReleaseStatus.NOT_EVALUATED,
        finding_outcome_counts={},
        timings_ms={},
        warnings_zh=[],
        warnings_en=[],
        run_revision=1,
    )


def main() -> int:
    os.environ.setdefault("DATAPILOT_AI_MODE", "auto")
    os.environ.setdefault("DATAPILOT_AI_CACHE", "off")
    runtime = get_runtime()
    info = runtime.info()
    print(f"provider={info.provider.value} model={info.model} mode={info.mode}")
    if info.provider is not ProviderName.ANTHROPIC:
        print("FAIL: live Anthropic provider not selected (no credentials resolved)")
        return 2

    run_id = "smoke"
    request = SemanticRequest(
        finding_id="SEM-diagnosis_label",
        column="diagnosis_label",
        candidate_counts={"high blood pressure": 9, "HTN (essential)": 6, "高血压": 5},
        canonical_vocabulary=["Hypertension", "Type 2 diabetes"],
        evidence_refs=["EVID-GLOSSARY-01", "EVID-CODE-02"],
        ambiguity_tokens=["MS", "RA", "CVA", "PCP"],
    )
    proposal, grounding, call_id = runtime.semantic_resolver(run_id).resolve(request, run_id=run_id)
    record = next(item for item in runtime.ledger_records(run_id) if item.call_id == call_id)
    print(
        f"semantic: status={record.status.value} model={record.model_served} "
        f"tokens={record.input_tokens}/{record.output_tokens} "
        f"cache_read={record.cache_read_tokens} "
        f"latency_ms={record.latency_ms} request_id={record.request_id}"
    )
    print(f"semantic: grounding valid={grounding.valid} reasons={grounding.reason_codes}")
    print(
        f"semantic: provider={proposal.provider} abstained={proposal.abstained} "
        f"mapping={proposal.mapping}"
    )
    ok = record.status in LIVE_STATUSES and grounding.valid and proposal.provider == "anthropic"
    if not ok:
        print(f"FAIL: semantic call did not succeed live (error={record.error})")

    draft = runtime.draft_contract(run_id, make_smoke_report())
    draft_record = next(
        item for item in runtime.ledger_records(run_id) if item.call_id == draft.ledger_call_id
    )
    print(
        f"draft: status={draft_record.status.value} model={draft_record.model_served} "
        f"tokens={draft_record.input_tokens}/{draft_record.output_tokens} "
        f"latency_ms={draft_record.latency_ms} accepted={len(draft.accepted_rules)} "
        f"rejected={[rule.reason_code for rule in draft.rejected_rules]}"
    )
    print(
        f"draft: grounding valid={draft_record.grounding.valid} "
        f"reasons={draft_record.grounding.reason_codes}"
    )
    if draft.draft_yaml:
        print("draft: yaml preview:")
        print("\n".join(f"  {line}" for line in draft.draft_yaml.splitlines()[:16]))
    if draft_record.status not in LIVE_STATUSES:
        print(f"FAIL: draft call did not succeed live (error={draft_record.error})")
        ok = False
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
