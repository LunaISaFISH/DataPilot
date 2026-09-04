"""Walk the whole demo beat sequence over HTTP and assert every response shape (spec §12).

    create from sample → wait → SSE tail → decisions → dry-run → tamper-test → apply → verify
    → artifacts (+ sha256 of release.csv against the manifest) → ai-ledger → red-team cases
    → brief

Usage:
    .venv/bin/python scripts/demo_smoke.py [--base http://127.0.0.1:8000]
        [--sample ecommerce_orders] [--live] [--timeout 180]

``--live`` additionally exercises the two endpoints that call the model (``LIVE_INJECTION``
red-team case and the semantic re-run) and expects the Anthropic provider. Exit code 0 when every
assertion holds, 1 otherwise. Only the standard library is used, so the script runs anywhere.
Never prints credentials.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Any

OFFLINE_REDTEAM_CASES = (
    "HALLUCINATED_SOURCE_VALUE",
    "UNKNOWN_CANONICAL_TARGET",
    "UNKNOWN_EVIDENCE_REFERENCE",
    "UNSUPPORTED_ACTION",
    "STALE_OR_UNKNOWN_INPUT",
    "ABSTENTION_WITH_MAPPING",
    "AMBIGUITY_REGISTRY_HIT",
    "TIMEOUT",
)
DECISION_PRIORITY = (
    "APPROVE_PROPOSAL",
    "EXCLUDE",
    "QUARANTINE",
    "FLAG_FOR_REVIEW",
    "REJECT_PROPOSAL",
)
EXPECTED_VALIDATIONS = 14


class SmokeFailure(AssertionError):
    pass


@dataclass
class Step:
    name: str
    status: int
    client_ms: int
    server_ms: float | None
    note: str = ""


@dataclass
class Client:
    base: str
    timeout: float
    steps: list[Step] = field(default_factory=list)

    def call(
        self,
        method: str,
        path: str,
        *,
        body: Any = None,
        headers: dict[str, str] | None = None,
        raw: bool = False,
        expect: tuple[int, ...] = (200,),
        name: str | None = None,
    ) -> tuple[int, Any, dict[str, str]]:
        data = None
        request_headers = dict(headers or {})
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            request_headers["Content-Type"] = "application/json"
        request = urllib.request.Request(
            self.base + path, data=data, method=method, headers=request_headers
        )
        started = time.perf_counter()
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                payload = response.read()
                status = response.status
                response_headers = {k.lower(): v for k, v in response.headers.items()}
        except urllib.error.HTTPError as error:
            payload = error.read()
            status = error.code
            response_headers = {k.lower(): v for k, v in error.headers.items()}
        client_ms = int((time.perf_counter() - started) * 1000)
        server_ms = _server_timing(response_headers.get("server-timing"))
        step = Step(name or f"{method} {path}", status, client_ms, server_ms)
        self.steps.append(step)
        if raw:
            parsed: Any = payload
        else:
            try:
                parsed = json.loads(payload.decode("utf-8")) if payload else None
            except ValueError:
                parsed = payload.decode("utf-8", "replace")
        if status not in expect:
            raise SmokeFailure(f"{step.name}: expected {expect}, got {status}: {str(parsed)[:400]}")
        return status, parsed, response_headers

    def sse_tail(
        self, run_id: str, *, max_events: int = 200, budget_s: float = 8.0
    ) -> list[dict[str, Any]]:
        """Read the persisted events (and tail live ones) with curl-like streaming semantics."""
        request = urllib.request.Request(
            f"{self.base}/v1/runs/{run_id}/events", headers={"Accept": "text/event-stream"}
        )
        events: list[dict[str, Any]] = []
        started = time.perf_counter()
        with urllib.request.urlopen(request, timeout=budget_s) as response:
            try:
                for raw_line in response:
                    line = raw_line.decode("utf-8").rstrip("\n")
                    if line.startswith("data:"):
                        events.append(json.loads(line[5:].strip()))
                        if len(events) >= max_events:
                            break
                    if time.perf_counter() - started > budget_s:
                        break
            except TimeoutError:
                pass
        self.steps.append(
            Step(
                f"GET /v1/runs/{run_id}/events (SSE)",
                200,
                int((time.perf_counter() - started) * 1000),
                None,
                f"{len(events)} events",
            )
        )
        return events


def _server_timing(value: str | None) -> float | None:
    if not value:
        return None
    for part in value.split(","):
        part = part.strip()
        if part.startswith("total;dur="):
            try:
                return float(part.split("=", 1)[1])
            except ValueError:
                return None
    return None


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise SmokeFailure(message)


def _approvable(finding: dict[str, Any]) -> bool:
    proposal = finding.get("proposal")
    return bool(
        proposal
        and proposal.get("grounding", {}).get("valid")
        and not proposal.get("abstained")
        and proposal.get("mapping")
    )


def derive_decisions(report: dict[str, Any]) -> list[dict[str, Any]]:
    """One decision per finding that needs one, chosen from its ``allowed_outcomes``."""
    decisions: list[dict[str, Any]] = []
    for finding in report["findings"]:
        if finding["authorization_mode"] in ("POLICY_AUTHORIZED", "FORBIDDEN"):
            continue
        allowed = finding["allowed_outcomes"]
        for outcome in DECISION_PRIORITY:
            if outcome not in allowed:
                continue
            semantic = finding["finding_type"] == "SEMANTIC_VARIANT"
            if outcome == "APPROVE_PROPOSAL" and semantic and not _approvable(finding):
                continue
            decisions.append(
                {"finding_id": finding["finding_id"], "outcome": outcome, "reason": "demo smoke"}
            )
            break
    return decisions


def wait_for_report(client: Client, run_id: str, *, timeout_s: float) -> dict[str, Any]:
    deadline = time.monotonic() + timeout_s
    while True:
        _, detail, _ = client.call("GET", f"/v1/runs/{run_id}", name="GET /v1/runs/{id} (poll)")
        lifecycle = detail["lifecycle"]
        if lifecycle in ("REVIEW_REQUIRED", "OBSERVATIONAL", "DRY_RUN_READY", "APPLIED"):
            return dict(detail)
        if lifecycle == "FAILED":
            raise SmokeFailure(f"run failed: {detail.get('error')}")
        if time.monotonic() > deadline:
            raise SmokeFailure(f"run {run_id} still {lifecycle} after {timeout_s}s")
        time.sleep(0.5)


def run(args: argparse.Namespace) -> int:
    client = Client(args.base.rstrip("/"), args.timeout)
    _, health, headers = client.call("GET", "/health")
    _require(health["status"] in ("ok", "degraded"), "health status missing")
    _require("x-correlation-id" in headers, "X-Correlation-Id header missing")
    ai = health["ai"]
    print(
        f"api {client.base} engine {health['engine_version']} ai mode={ai['mode']} "
        f"provider={ai['provider']} model={ai['model']} available={ai['available']} "
        f"samples={health['samples']}"
    )
    if args.live:
        _require(ai["provider"] == "anthropic", "--live requires the Anthropic provider")

    _, samples, _ = client.call("GET", "/v1/samples")
    ids = {item["id"] for item in samples}
    _require(args.sample in ids, f"sample {args.sample} not in {sorted(ids)}")
    for item in samples:
        for key in ("title_zh", "title_en", "description_zh", "description_en", "rows", "columns"):
            _require(key in item, f"sample {item.get('id')} lacks {key}")

    _, card, _ = client.call("GET", "/v1/ai/contract")
    for key in (
        "provider",
        "model",
        "prompt_versions",
        "system_prompts",
        "output_schemas",
        "max_calls_per_run",
        "visible_to_model",
        "never_visible",
        "allowed_proposals",
        "grounding_reason_codes",
        "canonical_test_vector",
    ):
        _require(key in card, f"AI permission card lacks {key}")
    vector = card["canonical_test_vector"]
    _require(
        hashlib.sha256(vector["json"].encode("utf-8")).hexdigest() == vector["sha256"],
        "canonical test vector sha256 mismatch",
    )

    _, created, _ = client.call(
        "POST",
        "/v1/runs/from-sample",
        body={"sample_id": args.sample, "with_contract": True},
        expect=(202,),
    )
    run_id = created["run_id"]
    print(f"run {run_id} lifecycle {created['lifecycle']}")
    detail = wait_for_report(client, run_id, timeout_s=args.timeout)
    report = detail["report"]
    _require(
        detail["lifecycle"] == "REVIEW_REQUIRED", f"unexpected lifecycle {detail['lifecycle']}"
    )
    _require(report["release_status"] == "BLOCKED", "expected BLOCKED before decisions")
    _require(report["contract"]["source"] == "sample", "contract source should be sample")
    findings = report["findings"]
    for finding in findings:
        for key in ("title_zh", "title_en", "explanation_zh", "explanation_en"):
            _require(bool(finding[key]), f"{finding['finding_id']} lacks {key}")
    sem_findings = [f for f in findings if f["finding_type"] == "SEMANTIC_VARIANT"]
    print(
        f"report {report['profile']['record_count']:,} records, {len(findings)} findings, "
        f"score {report['profile']['overall_score']}, withheld "
        f"{report['sensitive_preflight']['columns_withheld']}"
    )
    for finding in sem_findings:
        proposal = finding.get("proposal") or {}
        print(
            f"  {finding['finding_id']}: provider={proposal.get('provider')} "
            f"model={proposal.get('model')} mapping={proposal.get('mapping')} "
            f"abstained={proposal.get('abstained')} grounding={proposal.get('grounding')}"
        )
        if args.live:
            _require(proposal.get("provider") == "anthropic", "live SEM finding not from anthropic")

    events = client.sse_tail(run_id)
    stages = [event["stage"] for event in events]
    for stage in (
        "INGESTING",
        "PROFILING",
        "DETECTING",
        "SENSITIVE_PREFLIGHT",
        "SEMANTIC_ANALYSIS",
    ):
        _require(stage in stages, f"event stream lacks {stage}")
    _require(
        all(e["message_zh"] and e["message_en"] for e in events), "event without bilingual message"
    )
    _require(
        [e["seq"] for e in events] == sorted(e["seq"] for e in events), "event seq not ordered"
    )

    decisions = derive_decisions(report)
    _, decided, _ = client.call(
        "PUT", f"/v1/runs/{run_id}/decisions", body={"decisions": decisions}
    )
    _require(decided["unresolved"] == [], f"unresolved after decisions: {decided['unresolved']}")

    _, dry, _ = client.call("POST", f"/v1/runs/{run_id}/dry-run")
    dry_run = dry["dry_run"]
    preview = dry["preview"]
    _require(dry_run["status"] == "NOT_APPLIED", "dry run status")
    _require(dry_run["blocking_unresolved"] == [], "dry run still blocked")
    _require("changes" in preview and "totals" in preview, "preview shape")
    total = report["profile"]["record_count"]
    _require(
        dry_run["eligible_record_count"]
        + dry_run["quarantined_record_count"]
        + dry_run["excluded_record_count"]
        == total,
        "dry run reconciliation",
    )
    print(
        f"dry run: eligible {dry_run['eligible_record_count']:,} quarantined "
        f"{dry_run['quarantined_record_count']:,} excluded {dry_run['excluded_record_count']:,} "
        f"cells {dry_run['affected_cell_count']:,} actions {len(dry_run['actions'])}"
    )

    _, tamper, _ = client.call("POST", f"/v1/runs/{run_id}/tamper-test")
    _require(tamper["written"] is False, "tamper test must not write")
    if tamper["execution"] is not None:
        source_check = next(
            v for v in tamper["execution"]["validations"] if v["check_id"] == "SOURCE_IMMUTABLE"
        )
        _require(source_check["passed"] is False, "tamper test: SOURCE_IMMUTABLE should fail")
        _require(
            tamper["execution"]["release_manifest"]["release_status"] == "BLOCKED",
            "tamper test not BLOCKED",
        )
    else:
        _require(bool(tamper["refused"]["code"]), "tamper test refused without code")

    stale_status, stale, _ = client.call(
        "POST",
        f"/v1/runs/{run_id}/apply",
        body={"run_revision": detail["run_revision"], "approved_action_set_hash": "0" * 64},
        headers={"Idempotency-Key": f"smoke-stale-{run_id[:8]}"},
        expect=(409,),
        name="POST apply (stale hash → 409)",
    )
    _require(stale["error"]["code"] == "STALE_DRY_RUN", "stale apply code")
    _, execution, apply_headers = client.call(
        "POST",
        f"/v1/runs/{run_id}/apply",
        body={
            "run_revision": detail["run_revision"],
            "approved_action_set_hash": dry_run["approved_action_set_hash"],
        },
        headers={"Idempotency-Key": f"smoke-apply-{run_id[:8]}"},
    )
    manifest = execution["release_manifest"]
    validations = execution["validations"]
    _require(
        len(validations) == EXPECTED_VALIDATIONS, f"expected {EXPECTED_VALIDATIONS} validations"
    )
    failed = [v["check_id"] for v in validations if not v["passed"]]
    _require(not failed, f"validations failed: {failed}")
    _require(
        manifest["release_status"] in ("CONDITIONAL_PASS", "PASS"),
        f"release {manifest['release_status']}",
    )
    _require(
        manifest["decision_set_hash"] == dry_run["decision_set_hash"], "decision_set_hash mismatch"
    )
    _, replay, replay_headers = client.call(
        "POST",
        f"/v1/runs/{run_id}/apply",
        body={
            "run_revision": detail["run_revision"],
            "approved_action_set_hash": dry_run["approved_action_set_hash"],
        },
        headers={"Idempotency-Key": f"smoke-apply-{run_id[:8]}"},
        name="POST apply (idempotent replay)",
    )
    _require(
        replay_headers.get("x-idempotent-replay") == "true", "idempotent replay header missing"
    )
    _require(replay == execution, "idempotent replay body differs")
    print(
        f"apply: {manifest['release_status']} validations {manifest['validation_summary']} "
        f"ai_calls {manifest['ai_call_count']} provider {manifest['ai_provider']} "
        f"release {manifest['release_artifact_hash'][:12]}…"
    )

    _, verify, _ = client.call("GET", f"/v1/runs/{run_id}/verify")
    _require(
        verify["ok"] is True, f"verify failed: {[c for c in verify['checks'] if not c['passed']]}"
    )

    _, artifacts, _ = client.call("GET", f"/v1/runs/{run_id}/artifacts")
    names = {item["name"]: item for item in artifacts}
    for expected in (
        "source.csv",
        "report.json",
        "release.csv",
        "candidate.csv",
        "changes.jsonl",
        "release-manifest.json",
    ):
        _require(expected in names, f"artifact {expected} missing")
    _, release_bytes, _ = client.call("GET", f"/v1/runs/{run_id}/artifacts/release.csv", raw=True)
    _require(
        hashlib.sha256(release_bytes).hexdigest() == manifest["release_artifact_hash"],
        "release.csv sha256 does not match the manifest",
    )
    _, changes_bytes, _ = client.call("GET", f"/v1/runs/{run_id}/artifacts/changes.jsonl", raw=True)
    _require(
        hashlib.sha256(changes_bytes).hexdigest() == manifest["change_ledger_hash"],
        "changes.jsonl sha256 does not match the manifest",
    )
    _, bundle, _ = client.call("GET", f"/v1/runs/{run_id}/artifacts/audit-bundle.json")
    _require(
        bundle["release_manifest"]["release_artifact_hash"] == manifest["release_artifact_hash"],
        "audit bundle manifest",
    )

    _, ledger, _ = client.call("GET", f"/v1/runs/{run_id}/ai-ledger")
    for record in ledger:
        _require(record["redaction"]["rows_sent"] == 0, "ledger record sent rows")
        print(
            f"  ledger {record['call_id']}: task={record['task']} provider={record['provider']} "
            f"model={record['model_served']} status={record['status']} tokens="
            f"{record['input_tokens']}/{record['output_tokens']} latency={record['latency_ms']}ms "
            f"grounding={record['grounding']['valid']}"
        )
    if args.live:
        _require(
            any(r["provider"] == "anthropic" and r["input_tokens"] for r in ledger),
            "no live ledger record",
        )

    if sem_findings:
        finding_id = sem_findings[0]["finding_id"]
        cases = OFFLINE_REDTEAM_CASES + (("LIVE_INJECTION",) if args.live else ())
        for case in cases:
            _, verdict, _ = client.call(
                "POST",
                f"/v1/runs/{run_id}/findings/{finding_id}/redteam",
                body={"case": case},
                name=f"POST redteam {case}",
            )
            for key in (
                "case",
                "original_proposal",
                "tampered_proposal",
                "grounding",
                "ledger_call_id",
                "status",
            ):
                _require(key in verdict, f"redteam {case} lacks {key}")
            if case not in ("LIVE_INJECTION",):
                _require(
                    verdict["grounding"]["valid"] is False or case == "TIMEOUT",
                    f"redteam {case} not rejected",
                )
            reasons = verdict["grounding"]["reason_codes"]
            print(f"  redteam {case}: status={verdict['status']} reasons={reasons}")
        _, after, _ = client.call("GET", f"/v1/runs/{run_id}")
        _require(after["lifecycle"] == "APPLIED", "red-team changed the run lifecycle")

    brief_deadline = time.monotonic() + args.timeout
    while True:
        _, brief, _ = client.call("GET", f"/v1/runs/{run_id}/brief", name="GET /v1/runs/{id}/brief")
        if brief["status"] != "pending" or time.monotonic() > brief_deadline:
            break
        time.sleep(0.5)
    _require(brief["status"] in ("ready", "failed"), f"brief status {brief['status']}")
    if brief["status"] == "ready":
        _require(brief["total_count"] >= brief["verified_count"], "brief counts")
        print(
            f"brief: {brief['verified_count']}/{brief['total_count']} claims verified, "
            f"summary_zh={brief['summary_zh'][:60]!r}"
        )

    print()
    print(f"{'step':<52} {'status':>6} {'client ms':>9} {'server ms':>9}  note")
    for step in client.steps:
        server = f"{step.server_ms:.1f}" if step.server_ms is not None else "-"
        print(f"{step.name[:52]:<52} {step.status:>6} {step.client_ms:>9} {server:>9}  {step.note}")
    print(f"\nOK run {run_id}")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--base", default="http://127.0.0.1:8000")
    parser.add_argument("--sample", default="ecommerce_orders")
    parser.add_argument(
        "--live", action="store_true", help="also exercise the model-calling endpoints"
    )
    parser.add_argument("--timeout", type=float, default=180.0)
    args = parser.parse_args(argv)
    try:
        return run(args)
    except SmokeFailure as failure:
        print(f"\nFAIL: {failure}", file=sys.stderr)
        return 1
    except (urllib.error.URLError, TimeoutError) as error:
        print(f"\nFAIL: API unreachable: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
