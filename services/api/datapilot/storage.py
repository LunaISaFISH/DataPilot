"""On-disk run store (spec §6). Disk is the truth; every write is atomic.

Layout: ``<root>/<run_id>/{meta.json, source.csv, contract.yaml, report.json, decisions.json,
dry-run.json, preview.json, execution.json, candidate.csv, release.csv, release-manifest.json,
events.jsonl, ai-ledger.jsonl, brief.json, contract-draft.json}``.
"""

from __future__ import annotations

import json
import re
import shutil
import threading
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, TypeVar

from pydantic import BaseModel

from datapilot.contracts.models import (
    AICallRecord,
    EventStatus,
    Lifecycle,
    RunEvent,
    RunSummary,
)
from datapilot.serialization import (
    atomic_append_line,
    atomic_write_bytes,
    atomic_write_json,
    canonical_json,
)

META_FILE = "meta.json"
SOURCE_FILE = "source.csv"
CONTRACT_FILE = "contract.yaml"
EVENTS_FILE = "events.jsonl"
LEDGER_FILE = "ai-ledger.jsonl"

RUN_FILES = (
    META_FILE,
    SOURCE_FILE,
    CONTRACT_FILE,
    "report.json",
    "decisions.json",
    "dry-run.json",
    "preview.json",
    "execution.json",
    "candidate.csv",
    "release.csv",
    "release-manifest.json",
    EVENTS_FILE,
    LEDGER_FILE,
    "brief.json",
    "contract-draft.json",
)

META_FIELDS = (
    "run_id",
    "created_at",
    "source_name",
    "sample_id",
    "lifecycle",
    "run_revision",
    "record_count",
    "column_count",
    "release_status",
    "contract_source",
    "error",
)

_RUN_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")
_ARTIFACT_NAME = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")
_PROTECTED_ARTIFACTS = frozenset({META_FILE, SOURCE_FILE})

ModelT = TypeVar("ModelT", bound=BaseModel)


class StorageError(ValueError):
    def __init__(self, code: str, message_zh: str, message_en: str) -> None:
        self.code = code
        self.message_zh = message_zh
        self.message_en = message_en
        super().__init__(f"{code}: {message_en}")


def utc_now_iso() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _json_ready(value: Any) -> Any:
    if isinstance(value, BaseModel):
        return value.model_dump(mode="json")
    if isinstance(value, list):
        return [_json_ready(item) for item in value]
    if isinstance(value, dict):
        return {str(key): _json_ready(item) for key, item in value.items()}
    return value


def _require_writable_artifact(name: str) -> None:
    if name in _PROTECTED_ARTIFACTS:
        raise StorageError(
            "ARTIFACT_PROTECTED",
            f"工件 `{name}` 只能通过专用存储操作修改。",
            f"Artifact `{name}` can only be changed through its dedicated storage operation.",
        )


class RunStore:
    """Per-run artifact store. Safe for use from a small thread pool in one process."""

    def __init__(self, root: Path) -> None:
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._last_seq: dict[str, int] = {}

    # -- paths ------------------------------------------------------------------------

    def run_dir(self, run_id: str) -> Path:
        if not _RUN_ID.match(run_id):
            raise StorageError(
                "RUN_ID_INVALID",
                "运行 ID 格式无效。",
                "Run id has an invalid format.",
            )
        return self.root / run_id

    def path(self, run_id: str, name: str) -> Path:
        if not _ARTIFACT_NAME.match(name):
            raise StorageError(
                "ARTIFACT_NAME_INVALID",
                f"工件名 `{name}` 无效。",
                f"Artifact name `{name}` is invalid.",
            )
        return self.run_dir(run_id) / name

    def exists(self, run_id: str) -> bool:
        return (self.run_dir(run_id) / META_FILE).is_file()

    def has(self, run_id: str, name: str) -> bool:
        return self.path(run_id, name).is_file()

    def _require(self, run_id: str) -> Path:
        directory = self.run_dir(run_id)
        if not (directory / META_FILE).is_file():
            raise StorageError(
                "RUN_NOT_FOUND",
                f"运行 `{run_id}` 不存在。",
                f"Run `{run_id}` does not exist.",
            )
        return directory

    # -- lifecycle ----------------------------------------------------------------------

    def create(
        self,
        run_id: str,
        source_bytes: bytes,
        source_name: str,
        contract_yaml: str | None,
        sample_id: str | None,
    ) -> RunSummary:
        with self._lock:
            directory = self.run_dir(run_id)
            if (directory / META_FILE).exists():
                raise StorageError(
                    "RUN_EXISTS",
                    f"运行 `{run_id}` 已存在。",
                    f"Run `{run_id}` already exists.",
                )
            directory.mkdir(parents=True, exist_ok=True)
            atomic_write_bytes(directory / SOURCE_FILE, source_bytes)
            if contract_yaml is not None:
                atomic_write_bytes(directory / CONTRACT_FILE, contract_yaml.encode("utf-8"))
            meta: dict[str, Any] = {
                "run_id": run_id,
                "created_at": utc_now_iso(),
                "source_name": source_name,
                "sample_id": sample_id,
                "lifecycle": Lifecycle.QUEUED.value,
                "run_revision": 1,
                "record_count": None,
                "column_count": None,
                "release_status": None,
                "contract_source": None,
                "error": None,
            }
            atomic_write_json(directory / META_FILE, meta)
            self._last_seq[run_id] = 0
            return self._summary_from_meta(meta)

    def delete(self, run_id: str) -> bool:
        with self._lock:
            directory = self.run_dir(run_id)
            self._last_seq.pop(run_id, None)
            if not directory.exists():
                return False
            shutil.rmtree(directory)
            return True

    # -- meta ---------------------------------------------------------------------------

    def read_meta(self, run_id: str) -> dict[str, Any]:
        directory = self._require(run_id)
        loaded = json.loads((directory / META_FILE).read_text(encoding="utf-8"))
        if not isinstance(loaded, dict):
            raise StorageError(
                "META_CORRUPT",
                f"运行 `{run_id}` 的 meta.json 已损坏。",
                f"meta.json for run `{run_id}` is corrupt.",
            )
        return {str(key): value for key, value in loaded.items()}

    def update_meta(self, run_id: str, **fields: Any) -> dict[str, Any]:
        unknown = set(fields) - set(META_FIELDS) | ({"run_id"} & set(fields))
        if unknown:
            raise StorageError(
                "META_FIELD_INVALID",
                f"不允许更新 meta 字段：{sorted(unknown)}",
                f"meta fields cannot be updated: {sorted(unknown)}",
            )
        with self._lock:
            meta = self.read_meta(run_id)
            for key, value in fields.items():
                meta[key] = _json_ready(value)
            atomic_write_json(self.run_dir(run_id) / META_FILE, meta)
            return meta

    def summary(self, run_id: str) -> RunSummary:
        return self._summary_from_meta(self.read_meta(run_id))

    @staticmethod
    def _summary_from_meta(meta: dict[str, Any]) -> RunSummary:
        return RunSummary.model_validate(
            {key: meta.get(key) for key in META_FIELDS if key != "error"}
        )

    def list_runs(self) -> list[RunSummary]:
        summaries: list[RunSummary] = []
        for meta_path in self.root.glob(f"*/{META_FILE}"):
            try:
                loaded = json.loads(meta_path.read_text(encoding="utf-8"))
                if isinstance(loaded, dict):
                    summaries.append(self._summary_from_meta(loaded))
            except (OSError, ValueError):
                continue
        summaries.sort(key=lambda item: (item.created_at, item.run_id), reverse=True)
        return summaries

    # -- json / bytes artifacts -----------------------------------------------------------

    def write_json(self, run_id: str, name: str, obj: Any) -> Path:
        target = self.path(run_id, name)
        self._require(run_id)
        _require_writable_artifact(name)
        atomic_write_json(target, _json_ready(obj))
        return target

    def read_json(self, run_id: str, name: str) -> Any:
        target = self.path(run_id, name)
        if not target.is_file():
            raise StorageError(
                "ARTIFACT_NOT_FOUND",
                f"运行 `{run_id}` 缺少工件 `{name}`。",
                f"Run `{run_id}` has no artifact `{name}`.",
            )
        return json.loads(target.read_text(encoding="utf-8"))

    def read_model(self, run_id: str, name: str, model_type: type[ModelT]) -> ModelT | None:
        """Validate a stored JSON artifact into a strict model; ``None`` when absent."""
        target = self.path(run_id, name)
        if not target.is_file():
            return None
        return model_type.model_validate_json(target.read_text(encoding="utf-8"))

    def write_bytes(self, run_id: str, name: str, payload: bytes) -> Path:
        target = self.path(run_id, name)
        self._require(run_id)
        _require_writable_artifact(name)
        atomic_write_bytes(target, payload)
        return target

    def read_bytes(self, run_id: str, name: str) -> bytes:
        target = self.path(run_id, name)
        if not target.is_file():
            raise StorageError(
                "ARTIFACT_NOT_FOUND",
                f"运行 `{run_id}` 缺少工件 `{name}`。",
                f"Run `{run_id}` has no artifact `{name}`.",
            )
        return target.read_bytes()

    def read_source(self, run_id: str) -> bytes:
        return self.read_bytes(run_id, SOURCE_FILE)

    def read_contract_yaml(self, run_id: str) -> str | None:
        target = self.path(run_id, CONTRACT_FILE)
        if not target.is_file():
            return None
        return target.read_text(encoding="utf-8")

    def write_contract_yaml(self, run_id: str, text: str) -> Path:
        return self.write_bytes(run_id, CONTRACT_FILE, text.encode("utf-8"))

    def remove(self, run_id: str, name: str) -> bool:
        target = self.path(run_id, name)
        if name in (META_FILE, SOURCE_FILE):
            raise StorageError(
                "ARTIFACT_PROTECTED",
                f"工件 `{name}` 不可删除。",
                f"Artifact `{name}` cannot be removed.",
            )
        if not target.is_file():
            return False
        target.unlink()
        return True

    # -- events -------------------------------------------------------------------------

    def _read_jsonl(self, run_id: str, name: str) -> list[dict[str, Any]]:
        target = self.path(run_id, name)
        if not target.is_file():
            return []
        records: list[dict[str, Any]] = []
        with open(target, encoding="utf-8") as handle:
            for line in handle:
                stripped = line.strip()
                if not stripped:
                    continue
                loaded = json.loads(stripped)
                if isinstance(loaded, dict):
                    records.append({str(key): value for key, value in loaded.items()})
        return records

    def _current_seq(self, run_id: str) -> int:
        cached = self._last_seq.get(run_id)
        if cached is not None:
            return cached
        last = 0
        for record in self._read_jsonl(run_id, EVENTS_FILE):
            seq = record.get("seq")
            if isinstance(seq, int) and seq > last:
                last = seq
        self._last_seq[run_id] = last
        return last

    def append_event(
        self,
        run_id: str,
        stage: str,
        status: EventStatus,
        message_zh: str,
        message_en: str,
        *,
        elapsed_ms: int | None = None,
        detail: dict[str, Any] | None = None,
    ) -> RunEvent:
        with self._lock:
            self._require(run_id)
            seq = self._current_seq(run_id) + 1
            event = RunEvent(
                seq=seq,
                ts=utc_now_iso(),
                stage=stage,
                status=status,
                message_zh=message_zh,
                message_en=message_en,
                elapsed_ms=elapsed_ms,
                detail=_json_ready(detail or {}),
            )
            atomic_append_line(
                self.path(run_id, EVENTS_FILE), canonical_json(event.model_dump(mode="json"))
            )
            self._last_seq[run_id] = seq
            return event

    def read_events(self, run_id: str, after_seq: int = 0) -> list[RunEvent]:
        records = self._read_jsonl(run_id, EVENTS_FILE)
        events = [RunEvent.model_validate(record) for record in records]
        return [event for event in events if event.seq > after_seq]

    # -- AI ledger ----------------------------------------------------------------------

    def append_ledger(self, run_id: str, record: AICallRecord) -> AICallRecord:
        with self._lock:
            self._require(run_id)
            atomic_append_line(
                self.path(run_id, LEDGER_FILE), canonical_json(record.model_dump(mode="json"))
            )
        return record

    def read_ledger(self, run_id: str) -> list[AICallRecord]:
        return [
            AICallRecord.model_validate(record) for record in self._read_jsonl(run_id, LEDGER_FILE)
        ]

    def ledger_count(self, run_id: str) -> int:
        return len(self._read_jsonl(run_id, LEDGER_FILE))
