"""Pre-warm the AI response cache for the booth (spec §12, ``make demo-prewarm``).

Runs every sample with its contract once through the real engine with the configured provider
and ``DATAPILOT_AI_CACHE=fallback`` (default), so each semantic request — and the red-team
``LIVE_INJECTION`` request — is cached at ``<DATAPILOT_DATA_DIR>/ai-cache/<task>/<hash>.json``.
Prints latencies and cache paths. Nothing is written to the run store. Never prints credentials.

Usage: ``PYTHONPATH=services/api .venv/bin/python scripts/demo_prewarm.py [--sample id ...]``
"""

from __future__ import annotations

import argparse
import sys
import time

from datapilot.ai import get_runtime
from datapilot.ai.provider import AnthropicProvider, cache_root
from datapilot.contracts.models import AIProposal, AITask, ProviderName, SemanticRequest
from datapilot.contracts.policy import parse_contract
from datapilot.engine import analyze_csv, deterministic_proposal
from datapilot.samples import SAMPLES, get_sample, sample_contract_text


def _proposal(finding_id: str, request: SemanticRequest, summary: object) -> AIProposal:
    if summary is None:
        return deterministic_proposal(request)
    mapping = getattr(summary, "mapping", None)
    return AIProposal(
        finding_id=finding_id,
        proposed_action="NORMALIZE_CATEGORY" if mapping else None,
        column=request.column,
        mapping=dict(mapping) if mapping else None,
        evidence_refs=list(request.evidence_refs),
        semantic_explanation="prewarm",
        ambiguity_flags=[],
        abstained=bool(getattr(summary, "abstained", False)),
        abstain_reason=getattr(summary, "abstain_reason", None),
        provider=str(getattr(getattr(summary, "provider", None), "value", "deterministic")),
        model=str(getattr(summary, "model", "")),
        prompt_version=str(getattr(summary, "prompt_version", "")),
        input_hash=str(getattr(summary, "input_hash", "")),
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sample", action="append", dest="samples", default=None)
    parser.add_argument("--skip-injection", action="store_true")
    args = parser.parse_args(argv)
    runtime = get_runtime()
    info = runtime.info()
    print(
        f"provider={info.provider.value} model={info.model} mode={info.mode} cache={cache_root()}"
    )
    if info.provider is not ProviderName.ANTHROPIC:
        print("FAIL: the Anthropic provider is not active; nothing to pre-warm")
        return 1
    provider = runtime.provider
    cache = provider.cache if isinstance(provider, AnthropicProvider) else None
    failures = 0
    for sample_id in args.samples or list(SAMPLES):
        sample = get_sample(sample_id)
        contract_text = sample_contract_text(sample_id)
        if contract_text is None:
            print(f"{sample_id}: no contract, skipped")
            continue
        run_id = f"prewarm-{sample_id}"
        started = time.perf_counter()
        report = analyze_csv(
            sample.generate(),
            parse_contract(contract_text),
            ai=runtime.semantic_resolver(run_id),
            run_id=run_id,
            synthetic=sample.synthetic,
        )
        elapsed = int((time.perf_counter() - started) * 1000)
        sem = [f for f in report.findings if f.finding_type == "SEMANTIC_VARIANT"]
        print(f"{sample_id}: analyzed in {elapsed} ms, {len(sem)} semantic finding(s)")
        for finding in sem:
            request = SemanticRequest.model_validate(finding.details["request"])
            records = [
                r for r in runtime.ledger_records(run_id) if r.finding_id == finding.finding_id
            ]
            record = records[-1] if records else None
            status = record.status.value if record else "no-call"
            latency = record.latency_ms if record else 0
            path = cache.path(AITask.SEMANTIC, request_hash(record)) if cache and record else None
            ok = path is not None and path.is_file()
            failures += 0 if ok else 1
            print(
                f"  {finding.finding_id}: status={status} latency={latency} ms "
                f"mapping={finding.proposal.mapping if finding.proposal else None} "
                f"cache={'hit' if ok else 'MISSING'} {path or ''}"
            )
            if args.skip_injection:
                continue
            verdict = runtime.redteam(
                run_id,
                request,
                _proposal(finding.finding_id, request, finding.proposal),
                "LIVE_INJECTION",
            )
            injected = [
                r for r in runtime.ledger_records(run_id) if r.call_id == verdict["ledger_call_id"]
            ]
            inj_record = injected[-1] if injected else None
            inj_path = (
                cache.path(AITask.SEMANTIC, request_hash(inj_record))
                if cache and inj_record
                else None
            )
            inj_ok = inj_path is not None and inj_path.is_file()
            failures += 0 if inj_ok else 1
            inj_latency = inj_record.latency_ms if inj_record else 0
            print(
                f"  {finding.finding_id} LIVE_INJECTION: status={verdict['status']} "
                f"grounding={verdict['grounding']} latency={inj_latency} ms "
                f"cache={'hit' if inj_ok else 'MISSING'} {inj_path or ''}"
            )
    print("OK" if failures == 0 else f"FAIL: {failures} request(s) not cached")
    return 0 if failures == 0 else 1


def request_hash(record: object) -> str:
    return str(getattr(record, "input_hash", ""))


if __name__ == "__main__":
    sys.exit(main())
