"""Compatibility shim: the generator now lives in ``datapilot.samples.clinical_nlp``."""

from __future__ import annotations

from datapilot.samples.clinical_nlp import (
    FIELDNAMES,
    generate_csv_bytes,
    generate_rows,
    write_fixture,
)

__all__ = ["FIELDNAMES", "generate_csv_bytes", "generate_rows", "write_fixture"]
