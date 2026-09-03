from __future__ import annotations

import hashlib
from typing import Protocol

from datapilot.contracts.models import (
    AIProposal,
    GroundingResult,
    SemanticRequest,
)
from datapilot.serialization import canonical_json


class LLMProvider(Protocol):
    def assess(self, request: SemanticRequest) -> AIProposal: ...


class VerifiedReplayProvider:
    """Deterministic provider used only for the labeled synthetic replay."""

    def assess(self, request: SemanticRequest) -> AIProposal:
        if any(token in request.ambiguity_tokens for token in request.candidate_counts):
            return AIProposal(
                finding_id=request.finding_id,
                proposed_action=None,
                column=request.column,
                mapping=None,
                evidence_refs=request.evidence_refs,
                semantic_explanation="Known ambiguity prevents a safe canonical mapping.",
                ambiguity_flags=["KNOWN_AMBIGUOUS_ABBREVIATION"],
                abstained=True,
                abstain_reason="Candidate token is listed in the ambiguity registry.",
                provider="verified-replay",
                model="validated-fixture-output",
                prompt_version="semantic-1.0",
                input_hash=_request_hash(request),
            )
        canonical = request.canonical_vocabulary[0]
        return AIProposal(
            finding_id=request.finding_id,
            proposed_action="NORMALIZE_CATEGORY",
            column=request.column,
            mapping={source: canonical for source in request.candidate_counts},
            evidence_refs=request.evidence_refs,
            semantic_explanation=(
                "Observed variants align with the configured canonical term and evidence."
            ),
            ambiguity_flags=[],
            abstained=False,
            abstain_reason=None,
            provider="verified-replay",
            model="validated-fixture-output",
            prompt_version="semantic-1.0",
            input_hash=_request_hash(request),
        )


def _request_hash(request: SemanticRequest) -> str:
    return hashlib.sha256(canonical_json(request.model_dump(mode="json")).encode()).hexdigest()


def validate_proposal(
    request: SemanticRequest,
    proposal: AIProposal,
) -> GroundingResult:
    reasons: list[str] = []
    if proposal.finding_id != request.finding_id:
        reasons.append("UNKNOWN_FINDING")
    if proposal.column != request.column:
        reasons.append("UNKNOWN_COLUMN")
    if proposal.input_hash != _request_hash(request):
        reasons.append("STALE_OR_UNKNOWN_INPUT")
    mapping = proposal.mapping or {}
    unknown_sources = set(mapping) - set(request.candidate_counts)
    if unknown_sources:
        reasons.append("HALLUCINATED_SOURCE_VALUE")
    unknown_targets = set(mapping.values()) - set(request.canonical_vocabulary)
    if unknown_targets:
        reasons.append("UNKNOWN_CANONICAL_TARGET")
    if set(proposal.evidence_refs) - set(request.evidence_refs):
        reasons.append("UNKNOWN_EVIDENCE_REFERENCE")
    if set(mapping) & set(request.ambiguity_tokens):
        reasons.append("AMBIGUITY_REGISTRY_HIT")
    if proposal.proposed_action not in {None, "NORMALIZE_CATEGORY"}:
        reasons.append("UNSUPPORTED_ACTION")
    if proposal.abstained and mapping:
        reasons.append("ABSTENTION_WITH_MAPPING")
    affected = 0 if reasons or proposal.abstained else sum(
        request.candidate_counts[source] for source in mapping
    )
    return GroundingResult(
        valid=not reasons,
        reason_codes=reasons,
        affected_record_count=affected,
    )
