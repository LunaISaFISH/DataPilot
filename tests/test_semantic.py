from copy import deepcopy

import pytest
from datapilot.contracts.models import AIProposal, SemanticRequest
from datapilot.semantic import VerifiedReplayProvider, validate_proposal

REQUEST = SemanticRequest(
    finding_id="SEM-004",
    column="diagnosis_label",
    candidate_counts={"HTN": 72, "hypertension": 51},
    canonical_vocabulary=["Hypertension"],
    evidence_refs=["EVID-GLOSSARY-01", "EVID-CODE-02"],
    ambiguity_tokens=["MS", "RA", "CVA", "PCP"],
)


def test_verified_replay_proposal_is_grounded() -> None:
    proposal = VerifiedReplayProvider().assess(REQUEST)

    result = validate_proposal(REQUEST, proposal)

    assert result.valid is True
    assert result.affected_record_count == 123
    assert result.reason_codes == []


@pytest.mark.parametrize(
    ("mutation", "reason"),
    [
        ({"mapping": {"Invented": "Hypertension"}}, "HALLUCINATED_SOURCE_VALUE"),
        ({"mapping": {"HTN": "Invented target"}}, "UNKNOWN_CANONICAL_TARGET"),
        ({"evidence_refs": ["EVID-NOT-REAL"]}, "UNKNOWN_EVIDENCE_REFERENCE"),
        ({"column": "invented_column"}, "UNKNOWN_COLUMN"),
    ],
)
def test_grounding_rejects_ungrounded_proposals(
    mutation: dict[str, object],
    reason: str,
) -> None:
    base = VerifiedReplayProvider().assess(REQUEST).model_dump(mode="python")
    candidate = deepcopy(base)
    candidate.update(mutation)
    proposal = AIProposal.model_validate(candidate)

    result = validate_proposal(REQUEST, proposal)

    assert result.valid is False
    assert reason in result.reason_codes


def test_ambiguity_forces_abstention() -> None:
    request = REQUEST.model_copy(
        update={"candidate_counts": {"MS": 8}},
    )

    proposal = VerifiedReplayProvider().assess(request)
    result = validate_proposal(request, proposal)

    assert proposal.abstained is True
    assert proposal.mapping is None
    assert result.valid is True
