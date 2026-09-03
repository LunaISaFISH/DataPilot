from copy import deepcopy

import pytest
from datapilot.contracts.models import AIProposal, SemanticRequest
from datapilot.semantic import AnthropicProvider, VerifiedReplayProvider, validate_proposal

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


def test_anthropic_provider_uses_minimized_structured_payload() -> None:
    captured: dict[str, object] = {}

    def transport(payload: dict[str, object]) -> dict[str, object]:
        captured.update(payload)
        return {
            "content": [
                {
                    "type": "text",
                    "text": (
                        '{"finding_id":"SEM-004","proposed_action":"NORMALIZE_CATEGORY",'
                        '"column":"diagnosis_label","mapping":['
                        '{"source":"HTN","target":"Hypertension"},'
                        '{"source":"hypertension","target":"Hypertension"}],'
                        '"evidence_refs":['
                        '"EVID-GLOSSARY-01","EVID-CODE-02"],"semantic_explanation":'
                        '"Supported by configured evidence.","ambiguity_flags":[],'
                        '"abstained":false,"abstain_reason":null}'
                    ),
                }
            ]
        }

    proposal = AnthropicProvider("test-key", transport=transport).assess(REQUEST)
    result = validate_proposal(REQUEST, proposal)

    assert captured["model"] == "claude-haiku-4-5-20251001"
    assert captured["temperature"] == 0
    assert "output_config" in captured
    output_config = captured["output_config"]
    assert isinstance(output_config, dict)
    output_format = output_config["format"]
    assert isinstance(output_format, dict)
    assert "name" not in output_format
    assert "patient" not in str(captured).lower()
    assert proposal.mapping == {"HTN": "Hypertension", "hypertension": "Hypertension"}
    assert proposal.provider == "anthropic"
    assert result.valid is True
