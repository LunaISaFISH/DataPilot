.PHONY: test api web demo demo-reset golden

PY := .venv/bin/python
API_HOST ?= 127.0.0.1
API_PORT ?= 8000
WEB_PORT ?= 3000
API_URL  ?= http://$(API_HOST):$(API_PORT)

test:
	.venv/bin/pytest
	.venv/bin/ruff check services tests scripts conftest.py
	.venv/bin/mypy services/api/datapilot
	npm run lint
	npm run build

# Development API with auto-reload and docs enabled.
api:
	.venv/bin/uvicorn datapilot.api.main:app --reload --host $(API_HOST) --port $(API_PORT)

web:
	npm run dev -- --port $(WEB_PORT)

# Booth mode: API bound to loopback, no reload, docs disabled; web app alongside.
# Both processes stop together on Ctrl-C.
demo:
	@echo "DataPilot demo"
	@echo "  API  $(API_URL)   (docs disabled, no reload)"
	@echo "  Web  http://127.0.0.1:$(WEB_PORT)"
	@echo "  AI   mode=$${DATAPILOT_AI_MODE:-auto} model=$${ANTHROPIC_MODEL:-claude-opus-5} cache=$${DATAPILOT_AI_CACHE:-fallback}"
	@trap 'kill 0' INT TERM EXIT; \
	DATAPILOT_DOCS=0 .venv/bin/uvicorn datapilot.api.main:app --host $(API_HOST) --port $(API_PORT) & \
	sleep 1; \
	$(PY) -c "import json,urllib.request; h=json.load(urllib.request.urlopen('$(API_URL)/health')); print('  detected AI provider:', h['ai']['provider'], 'model:', h['ai']['model'], 'available:', h['ai']['available'])" || true; \
	NEXT_PUBLIC_API_BASE_URL=$(API_URL) npm run dev -- --port $(WEB_PORT) --host 127.0.0.1; \
	wait

# Booth reset against a running API: delete every run, then seed the three sample runs with
# contracts plus one observational ecommerce run.
demo-reset:
	@curl -fsS -X DELETE "$(API_URL)/v1/runs?older_than_minutes=0"; echo
	@for sample in clinical_nlp ecommerce_orders hr_roster; do \
	  curl -fsS -X POST "$(API_URL)/v1/runs/from-sample" -H 'Content-Type: application/json' \
	    -d "{\"sample_id\": \"$$sample\", \"with_contract\": true}"; echo; \
	done
	@curl -fsS -X POST "$(API_URL)/v1/runs/from-sample" -H 'Content-Type: application/json' \
	  -d '{"sample_id": "ecommerce_orders", "with_contract": false}'; echo

# Regenerate the clinical golden artifacts and public/demo replay files (replay AI mode).
golden:
	PYTHONPATH=services/api $(PY) scripts/generate_golden.py
