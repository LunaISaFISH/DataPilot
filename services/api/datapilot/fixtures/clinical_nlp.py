from __future__ import annotations

import csv
import io
from collections.abc import Iterable
from pathlib import Path

FIELDNAMES = [
    "record_id",
    "patient_token",
    "age_band",
    "sex",
    "region",
    "encounter_date",
    "diagnosis_label",
    "diagnosis_code",
    "procedure_code",
    "provider_type",
    "language",
    "source_system",
    "annotation_status",
    "review_tier",
    "model_score",
    "free_text_note",
    "import_batch_id",
    "updated_at",
]


def _base_row(index: int) -> dict[str, str]:
    regions = ("North", "South", "East", "West")
    return {
        "record_id": f"REC-{index + 1:05d}",
        "patient_token": f"SYN-{(index * 37) % 100_000:05d}",
        "age_band": ("18-34", "35-49", "50-64", "65+")[index % 4],
        "sex": ("F", "M", "Unknown")[index % 3],
        "region": regions[index % len(regions)],
        "encounter_date": f"2026-{(index % 9) + 1:02d}-{(index % 27) + 1:02d}",
        "diagnosis_label": "Type 2 diabetes",
        "diagnosis_code": "E11.9",
        "procedure_code": f"PROC-{index % 12:02d}",
        "provider_type": ("Hospital", "Clinic", "Telehealth")[index % 3],
        "language": ("en", "zh", "ms")[index % 3],
        "source_system": ("SYN-A", "SYN-B")[index % 2],
        "annotation_status": "accepted",
        "review_tier": ("1", "2")[index % 2],
        "model_score": f"{0.72 + (index % 23) / 100:.2f}",
        "free_text_note": "Synthetic note with no direct identifier.",
        "import_batch_id": f"BATCH-{index % 8:02d}",
        "updated_at": f"2026-09-{(index % 3) + 1:02d}T08:00:00Z",
    }


def generate_rows() -> list[dict[str, str]]:
    rows = [_base_row(index) for index in range(5_157)]

    region_aliases = ("north", "NORTH", "Northern")
    for offset, index in enumerate(range(0, 61)):
        rows[index]["region"] = region_aliases[offset % len(region_aliases)]

    for index in range(61, 133):
        month = (index % 9) + 1
        day = (index % 27) + 1
        rows[index]["encounter_date"] = f"{day:02d}/{month:02d}/2026"

    semantic_values: Iterable[tuple[str, int]] = (
        ("HTN", 73),
        ("hypertension", 51),
        ("HYPERTENSION", 28),
        ("Hypertension ", 32),
    )
    cursor = 133
    for value, count in semantic_values:
        for index in range(cursor, cursor + count):
            rows[index]["diagnosis_label"] = value
            rows[index]["diagnosis_code"] = "I10"
        cursor += count
    rows[133]["diagnosis_code"] = "E11.9"

    ambiguous = (("MS", "G35"), ("RA", "M06"), ("CVA", "I63"), ("PCP", "J18"))
    for offset, index in enumerate(range(317, 325)):
        label, code = ambiguous[offset % len(ambiguous)]
        rows[index]["diagnosis_label"] = label
        rows[index]["diagnosis_code"] = code

    for index in range(325, 352):
        rows[index]["diagnosis_code"] = ""

    sensitive_notes = (
        "Synthetic patient email: demo.patient@example.test",
        "Synthetic callback phone: +1 202 555 0182",
        "Synthetic direct identifier: Name: Example Person",
    )
    for note, index in zip(sensitive_notes, range(352, 355), strict=True):
        rows[index]["free_text_note"] = note

    rows.extend(dict(rows[index]) for index in range(1_000, 1_043))
    return rows


def generate_csv_bytes() -> bytes:
    buffer = io.StringIO(newline="")
    writer = csv.DictWriter(buffer, fieldnames=FIELDNAMES, lineterminator="\n")
    writer.writeheader()
    writer.writerows(generate_rows())
    return buffer.getvalue().encode("utf-8")


def write_fixture(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(generate_csv_bytes())
