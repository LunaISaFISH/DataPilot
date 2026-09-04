"""UCI Online Retail sample: real public data (CC BY 4.0), December 2010 subset (42,481 × 8).

Unlike the synthetic samples this module generates nothing: ``generate_csv_bytes`` returns the
bytes of ``fixtures/uci_online_retail/online_retail_2010_12.csv`` exactly as shipped (the file
is never regenerated; ``tests/test_samples.py`` pins its sha256). The quality issues listed in
``MEASURED`` were measured on the file while preparing it (see ``PROVENANCE.md``), not planted.
"""

from __future__ import annotations

from datapilot.samples._paths import FIXTURES_ROOT

FIXTURE_DIR = FIXTURES_ROOT / "uci_online_retail"
CSV_PATH = FIXTURE_DIR / "online_retail_2010_12.csv"
PROVENANCE_PATH = FIXTURE_DIR / "PROVENANCE.md"

FIELDNAMES = [
    "InvoiceNo",
    "StockCode",
    "Description",
    "Quantity",
    "InvoiceDate",
    "UnitPrice",
    "CustomerID",
    "Country",
]
ROW_COUNT = 42_481
CSV_SHA256 = "2e3400d76fe8d9043405a20a32b75d3c57be6607661ac88d8e0bc47d24b98176"
CSV_BYTES = 3_536_257

SOURCE_DOI = "https://doi.org/10.24432/C5BW33"
LICENSE = "CC BY 4.0"
ATTRIBUTION_EN = "Chen, D. (2015). Online Retail [Dataset]. UCI Machine Learning Repository."
ATTRIBUTION_ZH = "Chen, D. (2015). Online Retail 数据集，UCI 机器学习数据仓库。"

# Measured on the shipped file (record counts per expected finding id).
MEASURED: dict[str, int] = {
    "DUP-EXACT": 500,
    "FMT-InvoiceDate": 42_481,
    "SEM-Country": 403,
    "AMB-Country": 17,
    "MISS-CustomerID": 15_631,
    "VAL-Quantity": 798,
    "VAL-UnitPrice": 273,
}
SEMANTIC_CANDIDATES: dict[str, int] = {"EIRE": 403}
AMBIGUOUS_TOKENS: dict[str, int] = {"Channel Islands": 17}


def generate_csv_bytes() -> bytes:
    """Return the shipped file bytes verbatim (no generation, no normalisation)."""
    return CSV_PATH.read_bytes()
