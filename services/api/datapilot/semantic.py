"""Compatibility shim: the semantic layer now lives in :mod:`datapilot.ai` (spec §1).

Import from ``datapilot.ai`` in new code. This module only re-exports the names that older
call sites used.
"""

from __future__ import annotations

from datapilot.ai import (
    AIRuntime,
    AnthropicProvider,
    DeterministicProvider,
    LLMProvider,
    ProviderResult,
    SemanticResolver,
    get_runtime,
    select_provider,
    validate_proposal,
)
from datapilot.ai.grounding import request_hash
from datapilot.ai.redaction import build_semantic_payload
from datapilot.contracts.models import ProviderName


class VerifiedReplayProvider(DeterministicProvider):
    """Deterministic provider labelled ``verified-replay`` (golden generation and tests)."""

    def __init__(self) -> None:
        super().__init__(ProviderName.VERIFIED_REPLAY)


__all__ = [
    "AIRuntime",
    "AnthropicProvider",
    "DeterministicProvider",
    "LLMProvider",
    "ProviderResult",
    "SemanticResolver",
    "VerifiedReplayProvider",
    "build_semantic_payload",
    "get_runtime",
    "request_hash",
    "select_provider",
    "validate_proposal",
]
