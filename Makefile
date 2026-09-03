.PHONY: test api web

test:
	.venv/bin/pytest
	.venv/bin/ruff check services tests conftest.py
	.venv/bin/mypy services/api/datapilot
	npm run lint
	npm run build

api:
	.venv/bin/uvicorn datapilot.api.main:app --reload --port 8000

web:
	npm run dev

