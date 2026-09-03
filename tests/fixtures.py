from pathlib import Path

import pytest
from datapilot.engine import load_policy
from datapilot.fixtures.clinical_nlp import generate_csv_bytes


@pytest.fixture(scope="session")
def clinical_csv() -> bytes:
    return generate_csv_bytes()


@pytest.fixture(scope="session")
def clinical_policy() -> dict[str, object]:
    return load_policy(Path("fixtures/clinical_nlp/policy.yaml"))


@pytest.fixture(scope="session")
def clinical_policy_bytes() -> bytes:
    return Path("fixtures/clinical_nlp/policy.yaml").read_bytes()
