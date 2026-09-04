"""Regenerate the clinical golden artifacts and the offline replay files (spec §8).

The artifacts come from the *real* pipeline and API (an in-process app with an isolated data
directory), not from hand-assembled JSON: report, dry run, execution, release CSV, manifest and
the persisted event log. AI mode is forced to ``replay`` so the run is deterministic.

Usage: ``PYTHONPATH=services/api .venv/bin/python scripts/generate_golden.py``
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "services" / "api"))

os.environ["DATAPILOT_AI_MODE"] = "replay"
os.environ["DATAPILOT_SYNC_PIPELINE"] = "1"
os.environ.setdefault("DATAPILOT_AI_CACHE", "off")

from datapilot.api.main import Settings, create_app  # noqa: E402
from datapilot.contracts.models import RunReport  # noqa: E402
from datapilot.governance import demo_decisions  # noqa: E402
from datapilot.serialization import atomic_write_bytes, atomic_write_json  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

SAMPLE_ID = "clinical_nlp"


def main() -> int:
    fixture_root = ROOT / "fixtures" / SAMPLE_ID
    golden = fixture_root / "golden"
    public = ROOT / "public" / "demo"

    with tempfile.TemporaryDirectory(prefix="datapilot-golden-") as tmp:
        settings = Settings(data_dir=Path(tmp), sync_pipeline=True)
        with TestClient(create_app(settings)) as client:
            created = client.post("/v1/runs/from-sample", json={"sample_id": SAMPLE_ID})
            created.raise_for_status()
            run_id = created.json()["run_id"]
            detail = client.get(f"/v1/runs/{run_id}").json()
            if detail["lifecycle"] != "REVIEW_REQUIRED":
                print(f"unexpected lifecycle {detail['lifecycle']}: {detail.get('error')}")
                return 1
            report = RunReport.model_validate_json(json.dumps(detail["report"]))
            decisions = [
                {"finding_id": d.finding_id, "outcome": d.outcome.value, "reason": d.reason}
                for d in demo_decisions(report)
            ]
            decided = client.put(f"/v1/runs/{run_id}/decisions", json={"decisions": decisions})
            decided.raise_for_status()
            if decided.json()["unresolved"]:
                print(f"unresolved findings: {decided.json()['unresolved']}")
                return 1
            dry = client.post(f"/v1/runs/{run_id}/dry-run")
            dry.raise_for_status()
            action_hash = dry.json()["dry_run"]["approved_action_set_hash"]
            applied = client.post(
                f"/v1/runs/{run_id}/apply",
                json={"run_revision": 1, "approved_action_set_hash": action_hash},
                headers={"Idempotency-Key": "golden-generation-0001"},
            )
            if applied.status_code != 200:
                print(f"apply failed: {applied.text}")
                return 1
            execution = applied.json()
            events = client.get(f"/v1/runs/{run_id}/artifacts/events.jsonl")
            events.raise_for_status()
            release_csv = client.get(f"/v1/runs/{run_id}/artifacts/release.csv").content
            source_csv = (Path(tmp) / "runs" / run_id / "source.csv").read_bytes()
            event_list = [json.loads(line) for line in events.text.splitlines() if line.strip()]

    report_json = report.model_dump(mode="json")
    manifest_json = execution["release_manifest"]

    atomic_write_bytes(golden / "clinical_nlp.csv", source_csv)
    atomic_write_json(golden / "report.json", report_json)
    atomic_write_json(golden / "release-report.json", execution)
    atomic_write_json(golden / "events.json", event_list)
    atomic_write_json(public / "report.json", report_json)
    atomic_write_json(public / "release-report.json", execution)
    atomic_write_bytes(public / "cleaned.csv", release_csv)
    atomic_write_json(public / "release-manifest.json", manifest_json)
    atomic_write_json(public / "events.json", event_list)

    profile = report.profile
    print(f"run_id             {run_id}")
    print(f"records/columns    {profile.record_count} / {profile.column_count}")
    print(f"dataset_hash       {profile.dataset_hash}")
    print(f"findings           {len(report.findings)}")
    print(f"baseline score     {profile.overall_score}")
    print(f"candidate score    {execution['candidate_profile']['overall_score']}")
    print(f"release_status     {manifest_json['release_status']}")
    print(f"release hash       {manifest_json['release_artifact_hash']}")
    print(f"validations        {manifest_json['validation_summary']}")
    print(f"events             {len(event_list)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
