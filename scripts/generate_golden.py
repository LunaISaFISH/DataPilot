from pathlib import Path

from datapilot.engine import analyze_csv, load_policy
from datapilot.fixtures.clinical_nlp import generate_csv_bytes
from datapilot.governance import demo_decisions, execute, prepare_dry_run
from datapilot.serialization import atomic_write_bytes, atomic_write_json

ROOT = Path(__file__).resolve().parents[1]


def main() -> None:
    fixture_root = ROOT / "fixtures" / "clinical_nlp"
    source = generate_csv_bytes()
    report = analyze_csv(
        source,
        load_policy(fixture_root / "policy.yaml"),
        synthetic=True,
        fixture_version="clinical-nlp-1.0.0",
    )
    dry_run = prepare_dry_run(report, demo_decisions())
    bundle = execute(source, load_policy(fixture_root / "policy.yaml"), report, dry_run)
    events = [
        {"stage": "INGESTING", "status": "COMPLETED", "message": "5,200 records secured"},
        {"stage": "PROFILING", "status": "COMPLETED", "message": "18 fields profiled"},
        {"stage": "DETECTING", "status": "COMPLETED", "message": "Deterministic checks completed"},
        {
            "stage": "SEMANTIC_ANALYSIS",
            "status": "COMPLETED",
            "message": "Bounded semantic evidence evaluated",
        },
        {"stage": "REVIEW_REQUIRED", "status": "COMPLETED", "message": "Release brief ready"},
    ]
    atomic_write_bytes(fixture_root / "golden" / "clinical_nlp.csv", source)
    atomic_write_json(fixture_root / "golden" / "report.json", report.model_dump(mode="json"))
    atomic_write_json(
        fixture_root / "golden" / "release-report.json",
        bundle.result.model_dump(mode="json"),
    )
    atomic_write_json(fixture_root / "golden" / "events.json", events)
    atomic_write_json(ROOT / "public" / "demo" / "report.json", report.model_dump(mode="json"))
    atomic_write_json(
        ROOT / "public" / "demo" / "release-report.json",
        bundle.result.model_dump(mode="json"),
    )
    atomic_write_bytes(ROOT / "public" / "demo" / "cleaned.csv", bundle.release_csv)
    atomic_write_json(
        ROOT / "public" / "demo" / "release-manifest.json",
        bundle.result.release_manifest.model_dump(mode="json"),
    )
    atomic_write_json(ROOT / "public" / "demo" / "events.json", events)


if __name__ == "__main__":
    main()
