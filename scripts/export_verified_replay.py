"""Export a small, privacy-minimised booth replay from one completed public run.

The exporter reads an already APPLIED run, its AI ledger, recorded events, and the API's
independent verification result. It never runs the pipeline and never copies rows, record UIDs,
distinct-value samples, request payloads, or response payloads into the public snapshot.

Example:
    PYTHONPATH=services/api .venv/bin/python scripts/export_verified_replay.py \
      --api-base https://datapilotgo-api.fly.dev \
      --run-id <applied-run-id> \
      --out lib/data/uci-online-retail-replay.json
"""

from __future__ import annotations

import argparse
import json
import urllib.error
import urllib.request
from collections import Counter
from pathlib import Path
from typing import Any

from datapilot.engine import dataset_hash
from datapilot.serialization import atomic_write_json, canonical_json

EXPECTED_SAMPLE_ID = "uci_online_retail"
SNAPSHOT_SCHEMA_VERSION = "1.0"


class ExportError(RuntimeError):
    """Raised when a remote run cannot prove the replay invariants."""


def _get_json(url: str) -> Any:
    request = urllib.request.Request(url, headers={"Accept": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:  # noqa: S310
            return json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as error:
        raise ExportError(f"could not read {url}: {error}") from error


def _get_jsonl(url: str) -> list[dict[str, Any]]:
    request = urllib.request.Request(url, headers={"Accept": "application/x-ndjson"})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:  # noqa: S310
            text = response.read().decode("utf-8")
    except (urllib.error.URLError, TimeoutError, UnicodeDecodeError) as error:
        raise ExportError(f"could not read {url}: {error}") from error
    records: list[dict[str, Any]] = []
    for line in text.splitlines():
        if line.strip():
            value = json.loads(line)
            if not isinstance(value, dict):
                raise ExportError("events artifact contains a non-object record")
            records.append(value)
    return records


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise ExportError(message)


def _profile(source: dict[str, Any]) -> dict[str, Any]:
    return {
        "dataset_hash": source["dataset_hash"],
        "record_count": source["record_count"],
        "column_count": source["column_count"],
        "scope_hash": source["scope_hash"],
        "evaluation_scope_hash": source["evaluation_scope_hash"],
        "score_version": source["score_version"],
        "overall_score": source["overall_score"],
        "metrics": [
            {
                "name": item["name"],
                "numerator": item["numerator"],
                "denominator": item["denominator"],
                "score": item["score"],
                "scope_zh": item["scope_zh"],
                "scope_en": item["scope_en"],
            }
            for item in source["metrics"]
        ],
    }


def _safe_details(finding: dict[str, Any]) -> dict[str, Any]:
    details = finding.get("details") or {}
    finding_id = finding["finding_id"]
    if finding_id == "DUP-EXACT":
        return {
            "duplicate_group_count": details.get("duplicate_group_count"),
            "surplus_record_count": details.get("surplus_record_count"),
        }
    if finding_id == "FMT-InvoiceDate":
        return {
            "source_format": details.get("source_format"),
            "target_format": details.get("target_format"),
        }
    if finding_id == "SEM-Country":
        request = details.get("request") or {}
        return {
            "candidate_counts": request.get("candidate_counts", {}),
            "ambiguity_tokens": request.get("ambiguity_tokens", []),
        }
    if finding_id == "AMB-Country":
        return {
            "observed_counts": details.get("observed_counts", {}),
            "tokens": details.get("tokens", []),
        }
    if finding_id == "MISS-CustomerID":
        return {
            "automatic_imputation": details.get("automatic_imputation"),
            "empty_cell_count": details.get("empty_cell_count"),
        }
    violations = details.get("violations") or {}
    safe_violations = {
        name: {
            "record_count": value.get("record_count"),
            "distinct_values": value.get("distinct_values"),
        }
        for name, value in violations.items()
        if isinstance(value, dict)
    }
    return {"constraints": details.get("constraints", {}), "violations": safe_violations}


def _safe_proposal(proposal: dict[str, Any] | None) -> dict[str, Any] | None:
    if not proposal:
        return None
    return {
        "provider": proposal.get("provider"),
        "model": proposal.get("model"),
        "prompt_version": proposal.get("prompt_version"),
        "input_hash": proposal.get("input_hash"),
        "mapping": proposal.get("mapping"),
        "abstained": proposal.get("abstained"),
        "abstain_reason": proposal.get("abstain_reason"),
        "grounding": proposal.get("grounding"),
        "ledger_call_id": proposal.get("ledger_call_id"),
    }


def _safe_ledger_record(record: dict[str, Any]) -> dict[str, Any]:
    return {
        "call_id": record["call_id"],
        "finding_id": record.get("finding_id"),
        "task": record["task"],
        "provider": record["provider"],
        "model_requested": record.get("model_requested"),
        "model_served": record.get("model_served"),
        "prompt_version": record["prompt_version"],
        "input_hash": record["input_hash"],
        "output_hash": record["output_hash"],
        "input_tokens": record.get("input_tokens"),
        "output_tokens": record.get("output_tokens"),
        "latency_ms": record.get("latency_ms"),
        "status": record["status"],
        "grounding": record.get("grounding"),
        "redaction": record.get("redaction"),
        "created_at": record.get("created_at"),
    }


def build_snapshot(
    detail: dict[str, Any],
    ledger: list[dict[str, Any]],
    events: list[dict[str, Any]],
    verification: dict[str, Any],
    fixture_path: Path,
) -> dict[str, Any]:
    report = detail["report"]
    dry_run = detail["dry_run"]
    execution = detail["execution"]
    manifest = execution["release_manifest"]
    baseline = execution["baseline_profile"]
    candidate = execution["candidate_profile"]
    findings = report["findings"]
    dispositions = dry_run["finding_dispositions"]

    _require(detail["lifecycle"] == "APPLIED", "run is not APPLIED")
    _require(detail["sample_id"] == EXPECTED_SAMPLE_ID, "run is not the pinned UCI sample")
    _require(report["synthetic"] is False, "UCI replay must be marked as real data")
    source_hash = dataset_hash(fixture_path.read_bytes())
    source_chain = {
        source_hash,
        report["profile"]["dataset_hash"],
        baseline["dataset_hash"],
        candidate["dataset_hash"],
        dry_run["source_artifact_hash"],
        manifest["source_artifact_hash"],
    }
    _require(len(source_chain) == 1, "source hash chain does not reconcile")
    contract_chain = {
        report["contract"]["hash"],
        manifest["contract_hash"],
        manifest["policy_pack_hash"],
    }
    _require(len(contract_chain) == 1, "contract hash chain does not reconcile")
    _require(baseline["scope_hash"] == candidate["scope_hash"], "score scope changed")
    _require(baseline["score_version"] == candidate["score_version"], "score version changed")
    _require(len(findings) == len(dispositions), "not every finding has one disposition")
    _require(
        {item["finding_id"] for item in findings} == set(dispositions),
        "finding ledger mismatch",
    )
    _require(
        Counter(dispositions.values()) == Counter(manifest["finding_outcome_counts"]),
        "finding outcome counts do not conserve",
    )
    total = manifest["total_source_records"]
    releasable = (
        dry_run["eligible_record_count"]
        + dry_run["quarantined_record_count"]
        + dry_run["excluded_record_count"]
    )
    _require(total == releasable, "release row counts do not conserve")
    validations = execution["validations"]
    passed = sum(bool(item["passed"]) for item in validations)
    _require(passed == len(validations), "execution contains a failed validation")
    _require(
        manifest["validation_summary"] == {"passed": passed, "failed": 0},
        "validation summary mismatch",
    )
    _require(verification.get("ok") is True, "independent run verification failed")
    _require(
        all(item.get("passed") is True for item in verification.get("checks", [])),
        "verification check failed",
    )

    ledger_by_id = {item["call_id"]: item for item in ledger}
    referenced_calls: list[dict[str, Any]] = []
    for finding in findings:
        proposal = finding.get("proposal")
        if not proposal or not proposal.get("ledger_call_id"):
            continue
        call_id = proposal["ledger_call_id"]
        _require(call_id in ledger_by_id, f"proposal ledger call missing: {call_id}")
        record = ledger_by_id[call_id]
        _require(record["finding_id"] == finding["finding_id"], "AI finding id mismatch")
        _require(record["input_hash"] == proposal["input_hash"], "AI input hash mismatch")
        referenced_calls.append(_safe_ledger_record(record))
    _require(len(referenced_calls) == manifest["ai_call_count"], "manifest AI call count mismatch")

    safe_findings = [
        {
            "finding_id": finding["finding_id"],
            "finding_type": finding["finding_type"],
            "title_zh": finding["title_zh"],
            "title_en": finding["title_en"],
            "explanation_zh": finding["explanation_zh"],
            "explanation_en": finding["explanation_en"],
            "column": finding.get("column"),
            "affected_record_count": finding["affected_record_count"],
            "affected_cell_count": finding["affected_cell_count"],
            "risk_level": finding["risk_level"],
            "blocking": finding["blocking"],
            "authorization_mode": finding["authorization_mode"],
            "proposed_action": finding.get("proposed_action"),
            "disposition": dispositions[finding["finding_id"]],
            "evidence_signals": finding.get("evidence_signals", []),
            "details": _safe_details(finding),
            "proposal": _safe_proposal(finding.get("proposal")),
        }
        for finding in findings
    ]
    actions = [
        {
            "finding_id": action["finding_id"],
            "action_type": action["action_type"],
            "authorization_source": action["authorization_source"],
            "authorization_ref": action["authorization_ref"],
            "column": action.get("column"),
            "mapping": action.get("mapping"),
            "source_format": action.get("source_format"),
            "target_format": action.get("target_format"),
            "affected_record_count": len(action.get("record_uids", [])),
        }
        for action in dry_run["actions"]
    ]
    safe_validations = [
        {
            "check_id": item["check_id"],
            "passed": item["passed"],
            "observed": item["observed"],
            "expected": item["expected"],
        }
        for item in validations
    ]
    safe_events = [
        {
            "seq": item["seq"],
            "ts": item["ts"],
            "stage": item["stage"],
            "status": item["status"],
            "message_zh": item["message_zh"],
            "message_en": item["message_en"],
            "elapsed_ms": item.get("elapsed_ms"),
        }
        for item in events
    ]
    verification_checks = [
        {"check_id": item["check_id"], "passed": item["passed"]}
        for item in verification["checks"]
    ]
    return {
        "snapshot_schema_version": SNAPSHOT_SCHEMA_VERSION,
        "presentation": {
            "mode": "offline-replay",
            "live": False,
            "notice_zh": "已验证的离线回放，不是实时运行",
            "notice_en": "Verified offline replay; not a live run",
        },
        "run": {
            "run_id": detail["run_id"],
            "sample_id": detail["sample_id"],
            "source_name": detail["source_name"],
            "lifecycle": detail["lifecycle"],
            "run_revision": detail["run_revision"],
            "created_at": detail["created_at"],
        },
        "source": {
            "title_zh": "UCI 在线零售交易（2010 年 12 月）",
            "title_en": "UCI Online Retail transactions (December 2010)",
            "synthetic": False,
            "license": "CC BY 4.0",
            "doi": "10.24432/C5BW33",
            "source_url": "https://archive.ics.uci.edu/dataset/352/online-retail",
            "sha256": source_hash,
            "bytes": fixture_path.stat().st_size,
            "record_count": report["profile"]["record_count"],
            "column_count": report["profile"]["column_count"],
        },
        "provenance": {
            "schema_version": report["schema_version"],
            "engine_version": report["engine_version"],
            "score_version": baseline["score_version"],
            "scope_hash": baseline["scope_hash"],
            "evaluation_scope_hash": baseline["evaluation_scope_hash"],
            "contract_id": report["contract"]["id"],
            "contract_version": report["contract"]["version"],
            "contract_hash": report["contract"]["hash"],
            "policy_pack_hash": manifest["policy_pack_hash"],
        },
        "quality": {"baseline": _profile(baseline), "candidate": _profile(candidate)},
        "findings": safe_findings,
        "governance": {
            "actions": actions,
            "finding_dispositions": dispositions,
            "approved_action_set_hash": dry_run["approved_action_set_hash"],
            "decision_set_hash": dry_run["decision_set_hash"],
            "affected_record_count": dry_run["affected_record_count"],
            "affected_cell_count": dry_run["affected_cell_count"],
        },
        "release": {
            "release_status": manifest["release_status"],
            "source_artifact_hash": manifest["source_artifact_hash"],
            "candidate_artifact_hash": manifest["candidate_artifact_hash"],
            "release_artifact_hash": manifest["release_artifact_hash"],
            "change_ledger_hash": manifest["change_ledger_hash"],
            "eligible_record_count": dry_run["eligible_record_count"],
            "quarantined_record_count": dry_run["quarantined_record_count"],
            "excluded_record_count": dry_run["excluded_record_count"],
            "flagged_record_count": dry_run["flagged_record_count"],
            "excluded_columns": dry_run["excluded_columns"],
            "finding_outcome_counts": manifest["finding_outcome_counts"],
            "validation_summary": manifest["validation_summary"],
        },
        "ai": {
            "mode": "replay",
            "live": False,
            "provider": manifest["ai_provider"],
            "calls": referenced_calls,
        },
        "validations": safe_validations,
        "events": safe_events,
        "verification": {
            "ok": verification["ok"],
            "checks": verification_checks,
        },
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--api-base", required=True)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--out", type=Path)
    parser.add_argument(
        "--fixture",
        type=Path,
        default=Path("fixtures/uci_online_retail/online_retail_2010_12.csv"),
    )
    args = parser.parse_args(argv)
    base = args.api_base.rstrip("/")
    run = f"{base}/v1/runs/{args.run_id}"
    detail = _get_json(run)
    ledger = _get_json(f"{run}/ai-ledger")
    events = _get_jsonl(f"{run}/artifacts/events.jsonl")
    verification = _get_json(f"{run}/verify")
    if not isinstance(detail, dict) or not isinstance(ledger, list):
        raise ExportError("unexpected API response shape")
    snapshot = build_snapshot(detail, ledger, events, verification, args.fixture)
    if args.out:
        atomic_write_json(args.out, snapshot)
        print(f"wrote {args.out} ({len(canonical_json(snapshot))} bytes)")
    else:
        print(canonical_json(snapshot))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
