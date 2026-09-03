from pathlib import Path


def test_public_replay_uses_committed_golden_artifacts() -> None:
    golden = Path("fixtures/clinical_nlp/golden")
    public = Path("public/demo")

    assert (golden / "report.json").read_bytes() == (public / "report.json").read_bytes()
    assert (golden / "release-report.json").read_bytes() == (
        public / "release-report.json"
    ).read_bytes()
    assert (golden / "events.json").read_bytes() == (public / "events.json").read_bytes()
