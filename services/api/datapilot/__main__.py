"""Command-line entry point: ``python -m datapilot verify <run_dir>`` (spec §4).

Recomputes every hash in a run directory and re-runs the validations in memory, prints one row
per check and exits 0 when everything matches, 1 otherwise. Nothing is written.
"""

from __future__ import annotations

import argparse
import sys
from collections.abc import Sequence
from pathlib import Path

from datapilot.governance import verify_run


def _short(value: object) -> str:
    text = "-" if value is None else str(value)
    if len(text) > 40 and all(c in "0123456789abcdef" for c in text):
        return f"{text[:12]}…{text[-8:]}"
    return text if len(text) <= 40 else text[:37] + "…"


def verify_command(run_dir: Path, *, lang: str) -> int:
    report = verify_run(run_dir)
    width = max((len(check.check_id) for check in report.checks), default=8)
    header = f"{'check':<{width}}  result  {'observed':<24}  {'expected':<24}  message"
    print(header)
    print("-" * len(header))
    for check in report.checks:
        result = "PASS" if check.passed else "FAIL"
        message = check.message_zh if lang == "zh" else check.message_en
        print(
            f"{check.check_id:<{width}}  {result:<6}  {_short(check.observed):<24}  "
            f"{_short(check.expected):<24}  {message}"
        )
    passed = sum(1 for check in report.checks if check.passed)
    verdict = "OK" if report.ok else "MISMATCH"
    print(f"\n{verdict}: {passed}/{len(report.checks)} checks passed ({run_dir})")
    return 0 if report.ok else 1


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m datapilot")
    commands = parser.add_subparsers(dest="command", required=True)
    verify = commands.add_parser("verify", help="recompute every hash of a run directory")
    verify.add_argument("run_dir", type=Path)
    verify.add_argument("--lang", choices=("zh", "en"), default="zh")
    args = parser.parse_args(argv)
    if args.command == "verify":
        return verify_command(args.run_dir, lang=args.lang)
    parser.error(f"unknown command {args.command}")  # pragma: no cover - argparse exits
    return 2


if __name__ == "__main__":
    sys.exit(main())
