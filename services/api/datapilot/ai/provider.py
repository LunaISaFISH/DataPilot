"""LLM providers (spec §5.1, §5.2, §5.2b).

* :class:`AnthropicProvider` — official SDK, structured outputs, prompt caching on the system
  block, server-side refusal fallback, per-task timeout, optional on-disk response cache.
* :class:`DeterministicProvider` — the fallback that produces schema-identical results from
  deterministic rules; labelled ``deterministic`` or ``verified-replay``.
* :class:`TimeoutProvider` — test/red-team helper that always times out (fail-closed path).

Live API facts verified against ``anthropic==1.3.0`` on 2026-09-04 with ``claude-opus-5``:
``client.beta.messages.create`` accepted ``betas=["server-side-fallback-2026-07-01"]`` together
with ``fallbacks="default"``, ``output_config={"format": {...json_schema...}, "effort": ...}``
and a per-call ``timeout``; ``temperature``/``top_p``/``thinking`` are deliberately omitted.
The structured-output schema validator rejects ``maxItems`` on arrays ("property 'maxItems' is
not supported"), so list bounds are enforced by the pydantic output models instead.
"""

from __future__ import annotations

import fcntl
import json
import os
import re
import threading
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Protocol

import anthropic

from datapilot.ai.grounding import pattern_to_strptime
from datapilot.ai.redaction import normalize_text, payload_hash
from datapilot.contracts.models import AIStatus, AITask, ProviderName
from datapilot.serialization import atomic_write_json, canonical_json
from datapilot.storage import utc_now_iso

DEFAULT_MODEL = "claude-opus-5"
DETERMINISTIC_MODEL = "deterministic-rules-1.0"
SERVER_SIDE_FALLBACK_BETA = "server-side-fallback-2026-07-01"
AI_MODES = ("auto", "off", "replay")
CACHE_POLICIES = ("fallback", "prefer", "off")
_ERROR_LIMIT = 240
DAILY_CALL_CAP_EXCEEDED = "AI_DAILY_CALL_CAP_EXCEEDED"
DAILY_CALL_BUDGET_UNAVAILABLE = "AI_DAILY_CALL_BUDGET_UNAVAILABLE"


@dataclass(frozen=True)
class ProviderResult:
    data: dict[str, Any] | None
    status: AIStatus
    model_served: str | None
    input_tokens: int | None
    output_tokens: int | None
    cache_read_tokens: int | None
    latency_ms: int
    request_id: str | None
    error: str | None
    cached_at: str | None = None

    @property
    def ok(self) -> bool:
        return self.data is not None and self.status in (AIStatus.OK, AIStatus.CACHED)


class LLMProvider(Protocol):
    @property
    def name(self) -> ProviderName: ...

    @property
    def model(self) -> str: ...

    def complete_json(
        self,
        task: AITask,
        system: str,
        user_payload: dict[str, Any],
        schema: dict[str, Any],
        *,
        effort: str,
        max_tokens: int,
        timeout_s: float,
    ) -> ProviderResult: ...


# --------------------------------------------------------------------------------------
# environment
# --------------------------------------------------------------------------------------


def ai_mode() -> str:
    mode = os.environ.get("DATAPILOT_AI_MODE", "auto").strip().lower() or "auto"
    return mode if mode in AI_MODES else "auto"


def configured_model() -> str:
    return os.environ.get("ANTHROPIC_MODEL", "").strip() or DEFAULT_MODEL


def cache_policy() -> str:
    policy = os.environ.get("DATAPILOT_AI_CACHE", "fallback").strip().lower() or "fallback"
    return policy if policy in CACHE_POLICIES else "fallback"


def cache_root() -> Path:
    return Path(os.environ.get("DATAPILOT_DATA_DIR", ".data")) / "ai-cache"


def credentials_available() -> bool:
    """True when the SDK can resolve credentials (env key/token or an auth profile)."""
    try:
        client = anthropic.Anthropic()
    except Exception:  # noqa: BLE001 - any resolution failure means "not available"
        return False
    return bool(
        getattr(client, "api_key", None)
        or getattr(client, "auth_token", None)
        or getattr(client, "credentials", None)
    )


def _truncate_error(message: str) -> str:
    flat = re.sub(r"\s+", " ", message).strip()
    return flat[:_ERROR_LIMIT]


# --------------------------------------------------------------------------------------
# response cache (spec §5.2b)
# --------------------------------------------------------------------------------------


class ResponseCache:
    """``<root>/<task>/<input_hash>.json`` holding payload, response, model, usage, created_at."""

    def __init__(self, root: Path, policy: str = "fallback") -> None:
        self.root = Path(root)
        self.policy = policy if policy in CACHE_POLICIES else "fallback"

    @property
    def enabled(self) -> bool:
        return self.policy != "off"

    def path(self, task: AITask, input_hash: str) -> Path:
        return self.root / task.value / f"{input_hash}.json"

    def get(self, task: AITask, input_hash: str) -> dict[str, Any] | None:
        if not self.enabled:
            return None
        target = self.path(task, input_hash)
        if not target.is_file():
            return None
        try:
            loaded = json.loads(target.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None
        if not isinstance(loaded, dict) or not isinstance(loaded.get("response"), dict):
            return None
        return {str(key): value for key, value in loaded.items()}

    def put(
        self,
        task: AITask,
        input_hash: str,
        *,
        payload: dict[str, Any],
        response: dict[str, Any],
        model: str | None,
        usage: dict[str, int | None],
    ) -> Path | None:
        if not self.enabled:
            return None
        target = self.path(task, input_hash)
        try:
            atomic_write_json(
                target,
                {
                    "input_hash": input_hash,
                    "task": task.value,
                    "payload": payload,
                    "response": response,
                    "model": model,
                    "usage": usage,
                    "created_at": utc_now_iso(),
                },
            )
        except OSError:
            return None
        return target


# --------------------------------------------------------------------------------------
# persistent public-runtime budget
# --------------------------------------------------------------------------------------


class PersistentDailyCallBudget:
    """Process-safe UTC-day reservations for actual provider network calls.

    A sidecar lock is used because the JSON state file is atomically replaced. Corrupt or
    unreadable state fails closed: a public deployment must never reset spend merely because
    its accounting file cannot be trusted.
    """

    def __init__(self, root: Path, cap: int) -> None:
        self.root = Path(root)
        self.cap = max(0, cap)
        self._thread_lock = threading.RLock()

    @staticmethod
    def _day() -> str:
        return datetime.now(UTC).date().isoformat()

    def _state_path(self, day: str) -> Path:
        return self.root / f"{day}.json"

    def _lock_path(self, day: str) -> Path:
        return self.root / f"{day}.lock"

    def _read_used(self, day: str) -> int:
        path = self._state_path(day)
        if not path.is_file():
            return 0
        loaded = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(loaded, dict):
            raise ValueError("daily budget state is not an object")
        used = loaded.get("calls_used")
        if loaded.get("date") != day or not isinstance(used, int) or isinstance(used, bool):
            raise ValueError("daily budget state has invalid fields")
        if used < 0:
            raise ValueError("daily budget state has a negative call count")
        return used

    def reserve(self) -> tuple[bool, str | None]:
        """Reserve one call before network dispatch, including calls that later fail."""
        day = self._day()
        try:
            with self._thread_lock:
                self.root.mkdir(parents=True, exist_ok=True)
                with open(self._lock_path(day), "a+b") as lock_file:
                    fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
                    used = self._read_used(day)
                    if used >= self.cap:
                        return False, DAILY_CALL_CAP_EXCEEDED
                    atomic_write_json(
                        self._state_path(day),
                        {
                            "date": day,
                            "calls_used": used + 1,
                            "daily_cap": self.cap,
                            "updated_at": utc_now_iso(),
                        },
                    )
        except (OSError, ValueError, json.JSONDecodeError):
            return False, DAILY_CALL_BUDGET_UNAVAILABLE
        return True, None

    def status(self) -> dict[str, Any]:
        day = self._day()
        try:
            with self._thread_lock:
                self.root.mkdir(parents=True, exist_ok=True)
                with open(self._lock_path(day), "a+b") as lock_file:
                    fcntl.flock(lock_file.fileno(), fcntl.LOCK_SH)
                    used = self._read_used(day)
        except (OSError, ValueError, json.JSONDecodeError):
            return {
                "date": day,
                "daily_cap": self.cap,
                "calls_used": None,
                "remaining": 0,
                "exhausted": True,
                "available": False,
            }
        return {
            "date": day,
            "daily_cap": self.cap,
            "calls_used": used,
            "remaining": max(0, self.cap - used),
            "exhausted": used >= self.cap,
            "available": True,
        }


# --------------------------------------------------------------------------------------
# Anthropic
# --------------------------------------------------------------------------------------


def _block_attr(block: Any, key: str) -> Any:
    if isinstance(block, dict):
        return block.get(key)
    return getattr(block, key, None)


def _first_text(response: Any) -> str | None:
    content = getattr(response, "content", None)
    if not isinstance(content, list):
        return None
    for block in content:
        if _block_attr(block, "type") == "text":
            text = _block_attr(block, "text")
            return text if isinstance(text, str) else None
    return None


def _usage_int(usage: Any, key: str) -> int | None:
    value = _block_attr(usage, key) if usage is not None else None
    return value if isinstance(value, int) and not isinstance(value, bool) else None


class AnthropicProvider:
    """Official SDK adapter. Credentials come from the SDK's own resolution; never passed."""

    name: ProviderName = ProviderName.ANTHROPIC

    def __init__(
        self,
        model: str | None = None,
        *,
        client: Any | None = None,
        cache: ResponseCache | None = None,
        daily_budget: PersistentDailyCallBudget | None = None,
        use_server_side_fallback: bool = True,
    ) -> None:
        self._model = model or configured_model()
        self._client = client
        self.cache = cache
        self.daily_budget = daily_budget
        self.use_server_side_fallback = use_server_side_fallback

    @property
    def model(self) -> str:
        return self._model

    def _client_for(self, timeout_s: float) -> Any:
        if self._client is not None:
            return self._client
        return anthropic.Anthropic(max_retries=1, timeout=timeout_s)

    def request_kwargs(
        self,
        system: str,
        user_text: str,
        schema: dict[str, Any],
        *,
        effort: str,
        max_tokens: int,
        timeout_s: float,
    ) -> dict[str, Any]:
        kwargs: dict[str, Any] = {
            "model": self._model,
            "max_tokens": max_tokens,
            "system": [
                {"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}
            ],
            "messages": [{"role": "user", "content": user_text}],
            "output_config": {
                "format": {"type": "json_schema", "schema": schema},
                "effort": effort,
            },
            "timeout": timeout_s,
        }
        if self.use_server_side_fallback:
            kwargs["betas"] = [SERVER_SIDE_FALLBACK_BETA]
            kwargs["fallbacks"] = "default"
        return kwargs

    def complete_json(
        self,
        task: AITask,
        system: str,
        user_payload: dict[str, Any],
        schema: dict[str, Any],
        *,
        effort: str,
        max_tokens: int,
        timeout_s: float,
    ) -> ProviderResult:
        input_hash = payload_hash(user_payload)
        if self.cache is not None and self.cache.policy == "prefer":
            cached = self._from_cache(task, input_hash, live_error=None)
            if cached is not None:
                return cached
        result = self._live(
            system, user_payload, schema, effort=effort, max_tokens=max_tokens, timeout_s=timeout_s
        )
        if result.ok and result.data is not None:
            if self.cache is not None:
                self.cache.put(
                    task,
                    input_hash,
                    payload=user_payload,
                    response=result.data,
                    model=result.model_served,
                    usage={
                        "input_tokens": result.input_tokens,
                        "output_tokens": result.output_tokens,
                        "cache_read_tokens": result.cache_read_tokens,
                    },
                )
            return result
        if result.error in (DAILY_CALL_CAP_EXCEEDED, DAILY_CALL_BUDGET_UNAVAILABLE):
            return result
        if self.cache is not None:
            cached = self._from_cache(task, input_hash, live_error=result.error or result.status)
            if cached is not None:
                return cached
        return result

    def _from_cache(
        self, task: AITask, input_hash: str, *, live_error: str | None
    ) -> ProviderResult | None:
        if self.cache is None:
            return None
        entry = self.cache.get(task, input_hash)
        if entry is None:
            return None
        usage = entry.get("usage") if isinstance(entry.get("usage"), dict) else {}
        model = entry.get("model")
        created = entry.get("created_at")
        return ProviderResult(
            data=dict(entry["response"]),
            status=AIStatus.CACHED,
            model_served=model if isinstance(model, str) else None,
            input_tokens=_usage_int(usage, "input_tokens"),
            output_tokens=_usage_int(usage, "output_tokens"),
            cache_read_tokens=_usage_int(usage, "cache_read_tokens"),
            latency_ms=0,
            request_id=None,
            error=None if live_error is None else f"live call failed ({live_error}); cache hit",
            cached_at=created if isinstance(created, str) else None,
        )

    def _live(
        self,
        system: str,
        user_payload: dict[str, Any],
        schema: dict[str, Any],
        *,
        effort: str,
        max_tokens: int,
        timeout_s: float,
    ) -> ProviderResult:
        user_text = canonical_json(user_payload)
        kwargs = self.request_kwargs(
            system, user_text, schema, effort=effort, max_tokens=max_tokens, timeout_s=timeout_s
        )
        started = time.perf_counter()

        def elapsed() -> int:
            return int((time.perf_counter() - started) * 1000)

        def failure(status: AIStatus, error: str) -> ProviderResult:
            return ProviderResult(
                data=None,
                status=status,
                model_served=None,
                input_tokens=None,
                output_tokens=None,
                cache_read_tokens=None,
                latency_ms=elapsed(),
                request_id=None,
                error=_truncate_error(error),
            )

        if self.daily_budget is not None:
            allowed, reason = self.daily_budget.reserve()
            if not allowed:
                return failure(AIStatus.ERROR, reason or DAILY_CALL_BUDGET_UNAVAILABLE)

        try:
            response = self._client_for(timeout_s).beta.messages.create(**kwargs)
        except (anthropic.APITimeoutError, TimeoutError) as exc:
            return failure(AIStatus.TIMEOUT, f"timeout after {timeout_s:g}s: {exc}")
        except anthropic.APIStatusError as exc:
            return failure(AIStatus.ERROR, f"HTTP {exc.status_code}: {exc.message}")
        except anthropic.APIConnectionError as exc:
            return failure(AIStatus.ERROR, f"connection error: {exc}")
        except anthropic.AnthropicError as exc:
            return failure(AIStatus.ERROR, f"sdk error: {exc}")

        latency = elapsed()
        usage = getattr(response, "usage", None)
        served = getattr(response, "model", None)
        request_id = getattr(response, "_request_id", None)

        def done(
            data: dict[str, Any] | None, status: AIStatus, error: str | None
        ) -> ProviderResult:
            return ProviderResult(
                data=data,
                status=status,
                model_served=served if isinstance(served, str) else None,
                input_tokens=_usage_int(usage, "input_tokens"),
                output_tokens=_usage_int(usage, "output_tokens"),
                cache_read_tokens=_usage_int(usage, "cache_read_input_tokens"),
                latency_ms=latency,
                request_id=request_id if isinstance(request_id, str) else None,
                error=None if error is None else _truncate_error(error),
            )

        stop_reason = getattr(response, "stop_reason", None)
        if stop_reason == "refusal":
            return done(None, AIStatus.REFUSAL, "model refused the request")
        if stop_reason == "max_tokens":
            return done(None, AIStatus.ERROR, "response truncated (max_tokens)")
        text = _first_text(response)
        if text is None:
            return done(None, AIStatus.ERROR, "response had no text block")
        try:
            data = json.loads(text)
        except ValueError as exc:
            return done(None, AIStatus.ERROR, f"response was not JSON: {exc}")
        if not isinstance(data, dict):
            return done(None, AIStatus.ERROR, "response was not a JSON object")
        return done({str(key): value for key, value in data.items()}, AIStatus.OK, None)


# --------------------------------------------------------------------------------------
# Deterministic fallback
# --------------------------------------------------------------------------------------

_ID_NAME = re.compile(r"(^|_)id$|^id($|_)|_id_|_uid$|_key$", re.IGNORECASE)


def deterministic_semantic(payload: dict[str, Any]) -> dict[str, Any]:
    """normalize()-identity mapping only (spec §3.5); everything else stays unmapped."""
    candidates = payload.get("candidate_counts", {})
    vocabulary = [str(item) for item in payload.get("canonical_vocabulary", [])]
    ambiguity = {str(item) for item in payload.get("ambiguity_tokens", [])}
    by_norm: dict[str, str] = {}
    for target in vocabulary:
        by_norm.setdefault(normalize_text(target), target)
    mapping: list[dict[str, str]] = []
    flags: list[str] = []
    for candidate in candidates:
        source = str(candidate)
        if source in ambiguity:
            if "KNOWN_AMBIGUOUS_ABBREVIATION" not in flags:
                flags.append("KNOWN_AMBIGUOUS_ABBREVIATION")
            continue
        matched = by_norm.get(normalize_text(source))
        if matched is not None and matched != source:
            mapping.append({"source": source, "target": matched})
    if not mapping:
        return {
            "finding_id": payload.get("finding_id"),
            "proposed_action": None,
            "column": payload.get("column"),
            "mapping": None,
            "evidence_refs": [],
            "semantic_explanation": (
                "确定性规则：没有候选值在归一化（大小写/空白/全角半角）后与规范词表完全一致，"
                "因此不提出映射，交由人工有效性审查。"
                " (Deterministic rule: no candidate equals a vocabulary term after "
                "normalisation, so no mapping is proposed.)"
            ),
            "ambiguity_flags": flags,
            "abstained": True,
            "abstain_reason": "NO_NORMALIZED_MATCH",
        }
    return {
        "finding_id": payload.get("finding_id"),
        "proposed_action": "NORMALIZE_CATEGORY",
        "column": payload.get("column"),
        "mapping": mapping,
        "evidence_refs": [],
        "semantic_explanation": (
            f"确定性规则：{len(mapping)} 个候选值在归一化（大小写/空白/全角半角）后"
            "与规范词表完全一致。"
            f" (Deterministic rule: {len(mapping)} candidate(s) equal a vocabulary term after "
            "normalisation.)"
        ),
        "ambiguity_flags": flags,
        "abstained": False,
        "abstain_reason": None,
    }


def _draft_field(column: dict[str, Any], record_count: int) -> dict[str, Any] | None:
    name = str(column.get("name", ""))
    inferred = str(column.get("inferred_type", "string"))
    null_count = int(column.get("null_count", 0))
    distinct = int(column.get("distinct_count", 0))
    top_values = [
        (str(item.get("value")), int(item.get("count", 0)))
        for item in column.get("top_values", [])
        if isinstance(item, dict)
    ]
    sensitive = bool(column.get("heuristic_sensitive", False))
    refs = [str(ref) for ref in column.get("evidence_refs", [])]
    ref = {
        fact: f"PROFILE:{name}:{fact}"
        for fact in ("type", "null_rate", "distinct", "top_values", "format", "sensitive_hits")
    }

    required = null_count == 0 and inferred != "empty" and record_count > 0
    unique = record_count > 1 and distinct == record_count - null_count and distinct > 1
    typed = ("integer", "number", "date", "datetime", "boolean")
    field_type: str | None = inferred if inferred in typed else None
    fmt: str | None = None
    if field_type in ("date", "datetime"):
        for item in sorted(
            (p for p in column.get("format_patterns", []) if isinstance(p, dict)),
            key=lambda p: (-int(p.get("count", 0)), str(p.get("pattern"))),
        ):
            fmt = pattern_to_strptime(str(item.get("pattern", "")))
            if fmt is not None:
                break
    allowed: list[str] = []
    if (
        not sensitive
        and field_type is None
        and inferred == "string"
        and 1 < distinct <= 12
        and len(top_values) == distinct
    ):
        allowed = [value for value, _ in top_values]
    canonical: list[dict[str, Any]] = []
    if not sensitive and inferred == "string":
        groups: dict[str, list[tuple[str, int]]] = {}
        for value, count in top_values:
            groups.setdefault(normalize_text(value), []).append((value, count))
        for members in groups.values():
            if len(members) > 1:
                members.sort(key=lambda item: (-item[1], item[0]))
                canonical.append(
                    {"target": members[0][0], "aliases": [value for value, _ in members[1:]]}
                )
    if not any((required, unique, sensitive, field_type, allowed, canonical)):
        return None
    reasons_zh: list[str] = []
    reasons_en: list[str] = []
    used_refs: list[str] = []
    if required:
        reasons_zh.append("无空值")
        reasons_en.append("no nulls")
        used_refs.append(ref["null_rate"])
    if unique:
        reasons_zh.append("取值全部唯一")
        reasons_en.append("all values distinct")
        used_refs.append(ref["distinct"])
    if sensitive:
        reasons_zh.append("命中敏感启发式")
        reasons_en.append("sensitive heuristic hit")
        used_refs.append(ref["sensitive_hits"])
    if field_type:
        reasons_zh.append(f"推断类型 {field_type}")
        reasons_en.append(f"inferred type {field_type}")
        used_refs.append(ref["type"])
    if fmt:
        reasons_zh.append("主导日期格式")
        reasons_en.append("dominant date pattern")
        used_refs.append(ref["format"])
    if allowed or canonical:
        reasons_zh.append("低基数观测值")
        reasons_en.append("low-cardinality observed values")
        used_refs.append(ref["top_values"])
    return {
        "name": name,
        "required": required,
        "unique": unique,
        "type": field_type,
        "format": fmt,
        "sensitive": sensitive,
        "allowed": allowed,
        "canonical": canonical,
        "rationale_zh": (
            "确定性启发式："
            + "，".join(reasons_zh)
            + "。 (Deterministic heuristics: "
            + ", ".join(reasons_en)
            + ".)"
        ),
        "evidence_refs": [r for r in used_refs if r in refs],
    }


def deterministic_contract_draft(payload: dict[str, Any]) -> dict[str, Any]:
    record_count = int(payload.get("record_count", 0))
    fields: list[dict[str, Any]] = []
    for column in payload.get("columns", []):
        if isinstance(column, dict):
            drafted = _draft_field(column, record_count)
            if drafted is not None:
                fields.append(drafted)
    unique_fields = [field["name"] for field in fields if field["unique"]]
    business_key = [
        next(
            (name for name in unique_fields if _ID_NAME.search(name)),
            unique_fields[0],
        )
    ] if unique_fields else []
    return {
        "fields": fields,
        "business_key": business_key,
        "ambiguity": [],
        "notes_zh": (
            "确定性启发式草稿：必填=无空值，唯一=取值全部唯一，敏感=命中启发式，"
            "日期格式=主导观测模式，封闭取值集=不超过 12 个且全部可见的字符串取值。"
            "请人工核对后再确认。 (Deterministic heuristic draft; review before confirming.)"
        ),
    }


def _fmt_number(value: Any) -> str:
    if isinstance(value, bool) or value is None:
        return str(value)
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return f"{value:.2f}"
    return str(value)


def deterministic_brief(payload: dict[str, Any]) -> dict[str, Any]:
    facts = payload.get("facts", {}) if isinstance(payload.get("facts"), dict) else {}
    n = {key: _fmt_number(value) for key, value in facts.items()}
    claims: list[dict[str, Any]] = [
        {
            "text_zh": f"数据集共 {n.get('record_count')} 条记录、{n.get('column_count')} 个字段。",
            "text_en": (
                f"The dataset has {n.get('record_count')} records and "
                f"{n.get('column_count')} columns."
            ),
            "fact_ids": ["record_count", "column_count"],
        },
        {
            "text_zh": (
                f"共检测到 {n.get('finding_total')} 项发现：高风险 {n.get('finding_high')}、"
                f"中风险 {n.get('finding_medium')}、低风险 {n.get('finding_low')}。"
            ),
            "text_en": (
                f"{n.get('finding_total')} findings were detected: {n.get('finding_high')} high, "
                f"{n.get('finding_medium')} medium, {n.get('finding_low')} low risk."
            ),
            "fact_ids": ["finding_total", "finding_high", "finding_medium", "finding_low"],
        },
        {
            "text_zh": (
                f"发布状态为 {n.get('release_status')}，仍有 {n.get('blocking_open')} 项阻断性"
                "发现未处置。"
            ),
            "text_en": (
                f"Release status is {n.get('release_status')}; {n.get('blocking_open')} blocking "
                "finding(s) remain open."
            ),
            "fact_ids": ["release_status", "blocking_open"],
        },
    ]
    if facts.get("overall_score") is not None:
        claims.append(
            {
                "text_zh": f"基线综合质量分为 {n['overall_score']}。",
                "text_en": f"The baseline overall quality score is {n['overall_score']}.",
                "fact_ids": ["overall_score"],
            }
        )
    if "eligible_record_count" in facts:
        claims.append(
            {
                "text_zh": (
                    f"处置后可发布 {n['eligible_record_count']} 条，隔离 "
                    f"{n['quarantined_record_count']} 条，排除 {n['excluded_record_count']} 条，"
                    f"标记待复核 {n['flagged_record_count']} 条。"
                ),
                "text_en": (
                    f"After apply, {n['eligible_record_count']} records are eligible, "
                    f"{n['quarantined_record_count']} quarantined, "
                    f"{n['excluded_record_count']} excluded and "
                    f"{n['flagged_record_count']} flagged for review."
                ),
                "fact_ids": [
                    "eligible_record_count",
                    "quarantined_record_count",
                    "excluded_record_count",
                    "flagged_record_count",
                ],
            }
        )
        claims.append(
            {
                "text_zh": (
                    f"校验通过 {n['validations_passed']}/{n['validations_total']} 项。"
                ),
                "text_en": (
                    f"{n['validations_passed']} of {n['validations_total']} validations passed."
                ),
                "fact_ids": ["validations_passed", "validations_total"],
            }
        )
    summary_zh = "".join(claim["text_zh"] for claim in claims[:3])
    summary_en = " ".join(claim["text_en"] for claim in claims[:3])
    return {"summary_zh": summary_zh, "summary_en": summary_en, "claims": claims}


class DeterministicProvider:
    """Schema-identical deterministic results; never labelled as AI output."""

    def __init__(self, name: ProviderName = ProviderName.DETERMINISTIC) -> None:
        if name not in (ProviderName.DETERMINISTIC, ProviderName.VERIFIED_REPLAY):
            raise ValueError("DeterministicProvider must be deterministic or verified-replay")
        self._name = name

    @property
    def name(self) -> ProviderName:
        return self._name

    @property
    def model(self) -> str:
        return DETERMINISTIC_MODEL

    def complete_json(
        self,
        task: AITask,
        system: str,
        user_payload: dict[str, Any],
        schema: dict[str, Any],
        *,
        effort: str,
        max_tokens: int,
        timeout_s: float,
    ) -> ProviderResult:
        started = time.perf_counter()
        if task is AITask.SEMANTIC:
            data = deterministic_semantic(user_payload)
        elif task is AITask.CONTRACT_DRAFT:
            data = deterministic_contract_draft(user_payload)
        else:
            data = deterministic_brief(user_payload)
        return ProviderResult(
            data=data,
            status=AIStatus.OK,
            model_served=DETERMINISTIC_MODEL,
            input_tokens=None,
            output_tokens=None,
            cache_read_tokens=None,
            latency_ms=int((time.perf_counter() - started) * 1000),
            request_id=None,
            error=None,
        )


class TimeoutProvider:
    """Always times out: exercises the fail-closed path without touching the network."""

    name: ProviderName = ProviderName.ANTHROPIC

    def __init__(self, model: str | None = None) -> None:
        self._model = model or configured_model()

    @property
    def model(self) -> str:
        return self._model

    def complete_json(
        self,
        task: AITask,
        system: str,
        user_payload: dict[str, Any],
        schema: dict[str, Any],
        *,
        effort: str,
        max_tokens: int,
        timeout_s: float,
    ) -> ProviderResult:
        return ProviderResult(
            data=None,
            status=AIStatus.TIMEOUT,
            model_served=None,
            input_tokens=None,
            output_tokens=None,
            cache_read_tokens=None,
            latency_ms=0,
            request_id=None,
            error=f"simulated timeout after {timeout_s:g}s",
        )


# --------------------------------------------------------------------------------------
# selection (spec §5.1)
# --------------------------------------------------------------------------------------


def select_provider(mode: str | None = None, model: str | None = None) -> LLMProvider:
    chosen = mode or ai_mode()
    if chosen == "replay":
        return DeterministicProvider(ProviderName.VERIFIED_REPLAY)
    if chosen == "off" or not credentials_available():
        return DeterministicProvider(ProviderName.DETERMINISTIC)
    cache = ResponseCache(cache_root(), cache_policy())
    return AnthropicProvider(model or configured_model(), cache=cache)


def configure_public_provider(
    provider: LLMProvider, *, data_root: Path, daily_call_cap: int
) -> PersistentDailyCallBudget | None:
    """Attach public-mode persistence and prefer an existing response cache."""
    if not isinstance(provider, AnthropicProvider):
        return None
    budget = PersistentDailyCallBudget(data_root / "public-runtime" / "ai-budget", daily_call_cap)
    provider.daily_budget = budget
    if provider.cache is not None and provider.cache.enabled:
        provider.cache = ResponseCache(data_root / "ai-cache", "prefer")
    return budget


def daily_budget_status(provider: LLMProvider) -> dict[str, Any] | None:
    if not isinstance(provider, AnthropicProvider) or provider.daily_budget is None:
        return None
    return provider.daily_budget.status()
