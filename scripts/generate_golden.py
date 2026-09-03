from pathlib import Path

from datapilot.engine import analyze_csv, load_policy
from datapilot.fixtures.clinical_nlp import generate_csv_bytes
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
    atomic_write_bytes(fixture_root / "golden" / "clinical_nlp.csv", source)
    atomic_write_json(fixture_root / "golden" / "report.json", report.model_dump(mode="json"))


if __name__ == "__main__":
    main()
