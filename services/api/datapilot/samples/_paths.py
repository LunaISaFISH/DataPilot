"""Filesystem locations shared by bundled samples in source and container installs."""

from __future__ import annotations

from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[4]


def resolve_fixtures_root(
    project_root: Path = PROJECT_ROOT,
    working_directory: Path | None = None,
) -> Path:
    """Locate fixtures from a checkout or from the container working directory."""
    source_fixtures = project_root / "fixtures"
    if source_fixtures.is_dir():
        return source_fixtures
    return (working_directory or Path.cwd()) / "fixtures"


FIXTURES_ROOT = resolve_fixtures_root()
