from __future__ import annotations

import os

from datapilot.contracts.models import SemanticRequest
from datapilot.semantic import AnthropicProvider, validate_proposal


def assess(model: str) -> None:
    request = SemanticRequest(
        finding_id="SEM-SMOKE",
        column="diagnosis_label",
        candidate_counts={"HTN": 3, "High blood pressure": 2},
        canonical_vocabulary=["Hypertension"],
        evidence_refs=["EVID-GLOSSARY-SMOKE", "EVID-CODE-SMOKE"],
        ambiguity_tokens=["MS", "RA", "CVA", "PCP"],
    )
    proposal = AnthropicProvider(os.environ["ANTHROPIC_API_KEY"], model=model).assess(request)
    grounding = validate_proposal(request, proposal)
    if not grounding.valid:
        raise SystemExit(f"grounding rejected: {','.join(grounding.reason_codes)}")
    print(
        f"model={model} valid=true abstained={str(proposal.abstained).lower()} "
        f"affected={grounding.affected_record_count}"
    )


def main() -> None:
    assess(os.getenv("ANTHROPIC_MODEL", "claude-haiku-4-5-20251001"))
    if os.getenv("RUN_QUALITY") == "1":
        assess(os.getenv("ANTHROPIC_QUALITY_MODEL", "claude-sonnet-4-6"))


if __name__ == "__main__":
    main()
