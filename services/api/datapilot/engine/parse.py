"""CSV parsing with hard limits (spec §3.1).

Everything is read as strings (``infer_schema=False``); the engine infers types itself so
Polars never silently coerces a value. ``dataset_hash`` is always computed over the uploaded
bytes, even when the file had to be transcoded from GB18030 for parsing.
"""

from __future__ import annotations

import csv
import hashlib
import io
from typing import Literal, NamedTuple

import polars as pl

MAX_UPLOAD_BYTES = 25 * 1024 * 1024
MAX_ROWS = 250_000
MAX_COLUMNS = 200
DELIMITERS = (",", "\t", ";")
UTF8_BOM = b"\xef\xbb\xbf"

SourceEncoding = Literal["utf-8", "utf-8-sig", "gb18030"]


class AnalysisError(ValueError):
    """Bilingual, coded analysis failure surfaced to the API as a 4xx body."""

    def __init__(self, code: str, message_zh: str, message_en: str) -> None:
        self.code = code
        self.message_zh = message_zh
        self.message_en = message_en
        super().__init__(f"{code}: {message_en}")


class ParsedCsv(NamedTuple):
    """``(frame, encoding)`` — unpack as ``frame, encoding = parse_csv(content)``."""

    frame: pl.DataFrame
    encoding: SourceEncoding


def dataset_hash(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def record_uid(dataset_hash_value: str, ordinal: int) -> str:
    return hashlib.sha256(f"{dataset_hash_value}:{ordinal}".encode()).hexdigest()[:24]


def record_uids(dataset_hash_value: str, count: int) -> list[str]:
    return [record_uid(dataset_hash_value, ordinal) for ordinal in range(count)]


def decode_source(content: bytes) -> tuple[str, SourceEncoding]:
    """UTF-8 / UTF-8-BOM first, then GB18030; anything else is unsupported."""
    if content.startswith(UTF8_BOM):
        try:
            return content[len(UTF8_BOM) :].decode("utf-8"), "utf-8-sig"
        except UnicodeDecodeError as error:
            raise _encoding_error() from error
    try:
        return content.decode("utf-8"), "utf-8"
    except UnicodeDecodeError:
        pass
    try:
        return content.decode("gb18030"), "gb18030"
    except UnicodeDecodeError as error:
        raise _encoding_error() from error


def _encoding_error() -> AnalysisError:
    return AnalysisError(
        "CSV_ENCODING_UNSUPPORTED",
        "仅支持 UTF-8 或 GB18030 编码的 CSV，请另存为 UTF-8",
        "Only UTF-8 or GB18030 encoded CSV files are supported; re-save the file as UTF-8.",
    )


def sniff_delimiter(text: str) -> str:
    """Pick the delimiter with the most occurrences in the header line (``,`` on a tie)."""
    header_line = text.split("\n", 1)[0]
    best = ","
    best_count = -1
    for candidate in DELIMITERS:
        count = header_line.count(candidate)
        if count > best_count:
            best, best_count = candidate, count
    return best


def read_header(text: str, delimiter: str) -> list[str]:
    try:
        header = next(csv.reader(io.StringIO(text), delimiter=delimiter))
    except (csv.Error, StopIteration) as error:
        raise AnalysisError(
            "CSV_EMPTY",
            "CSV 为空或没有表头行。",
            "The CSV is empty or has no header row.",
        ) from error
    if not header or any(not column.strip() for column in header):
        raise AnalysisError(
            "CSV_HEADER_INVALID",
            "CSV 的每一列都必须有列名。",
            "Every CSV column must have a name.",
        )
    if len(set(header)) != len(header):
        raise AnalysisError(
            "CSV_DUPLICATE_COLUMNS",
            "CSV 存在重复的列名，无法安全解析。",
            "Duplicate column names are not supported.",
        )
    return header


def parse_csv(content: bytes) -> ParsedCsv:
    """Parse ``content`` into an all-string frame. Raises ``AnalysisError`` on any limit."""
    frame, _delimiter, encoding = parse_csv_detailed(content)
    return ParsedCsv(frame=frame, encoding=encoding)


def parse_csv_detailed(content: bytes) -> tuple[pl.DataFrame, str, SourceEncoding]:
    """Like ``parse_csv`` but also returns the sniffed delimiter."""
    if not content:
        raise AnalysisError("CSV_EMPTY", "CSV 为空。", "The CSV is empty.")
    if len(content) > MAX_UPLOAD_BYTES:
        raise AnalysisError(
            "CSV_TOO_LARGE",
            f"CSV 超过 {MAX_UPLOAD_BYTES // (1024 * 1024)} MiB 上限。",
            f"The CSV exceeds the {MAX_UPLOAD_BYTES // (1024 * 1024)} MiB limit.",
        )
    text, encoding = decode_source(content)
    delimiter = sniff_delimiter(text)
    header = read_header(text, delimiter)
    if len(header) > MAX_COLUMNS:
        raise AnalysisError(
            "CSV_TOO_MANY_COLUMNS",
            f"CSV 列数 {len(header)} 超过 {MAX_COLUMNS} 列上限。",
            f"The CSV has {len(header)} columns; the limit is {MAX_COLUMNS}.",
        )
    try:
        frame = pl.read_csv(
            io.BytesIO(text.encode("utf-8")),
            separator=delimiter,
            has_header=True,
            infer_schema=False,
            quote_char='"',
            try_parse_dates=False,
        )
    except pl.exceptions.PolarsError as error:
        raise AnalysisError(
            "CSV_PARSE_FAILED",
            "CSV 无法被安全解析（可能存在行长度不一致或引号不闭合）。",
            "The CSV could not be parsed safely (ragged rows or unbalanced quotes).",
        ) from error
    if frame.width != len(header):
        raise AnalysisError(
            "CSV_PARSE_FAILED",
            "CSV 表头与数据列数不一致。",
            "The CSV header and data columns do not agree.",
        )
    if frame.height == 0:
        raise AnalysisError(
            "CSV_NO_RECORDS",
            "CSV 没有数据记录。",
            "The CSV contains no data records.",
        )
    if frame.height > MAX_ROWS:
        raise AnalysisError(
            "CSV_TOO_MANY_ROWS",
            f"CSV 行数超过 {MAX_ROWS:,} 行上限。",
            f"The CSV exceeds the {MAX_ROWS:,}-record limit.",
        )
    frame = frame.select([pl.col(column).cast(pl.String) for column in frame.columns])
    return frame, delimiter, encoding
