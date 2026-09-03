# DataPilot

DataPilot is an explainable release gate for tabular datasets. It separates deterministic
observations, policy decisions, human review, deterministic execution, and validation.

## Local development

Requirements: Node.js 22+, Python 3.12+.

```bash
npm install
python3 -m venv .venv
.venv/bin/pip install -e '.[dev]'
.venv/bin/uvicorn datapilot.api.main:app --reload --port 8000
npm run dev
```

Run the minimum verification gate:

```bash
make test
```

Open `http://localhost:3000` for the bilingual dashboard. The language switch persists across
the upload workspace and the complete verified replay. API docs are available at
`http://localhost:8000/docs`.

Generate the deterministic replay artifacts:

```bash
PYTHONPATH=services/api .venv/bin/python scripts/generate_golden.py
```

The opt-in Anthropic smoke test is intentionally separate from normal tests. It sends only a
small aggregate semantic request; use the manual GitHub workflow to run Haiku once, and enable
the quality input only when one Sonnet comparison is needed.

The public demonstration uses synthetic data only. The live CSV endpoint is observational
unless a valid Data Contract/Policy Pack is supplied.

## Truth boundaries

- The model never receives dataframe write access and never produces executable code.
- Source CSV artifacts are immutable.
- A proposal is not an action; policy and required review must authorize it.
- Quality score and release status are separate.
- The demo replay is labeled and never presented as a live model run.
- Potential sensitive-data detection is a conservative heuristic, not a compliance claim.
