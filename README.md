# DataPilot v0.2

DataPilot is an explainable release gate for tabular datasets: **AI proposes · policy decides · humans decide high-risk · deterministic rules execute · validations gate release.** It profiles UTF-8/GB18030 CSVs with Polars, evaluates a Data Contract, lets Anthropic propose bounded semantic mappings, grounds every proposal against observed evidence, and publishes only after deterministic post-condition checks pass.

This is not chat-with-CSV. The model receives no raw rows or sensitive values, cannot write the dataframe, cannot generate executable actions, and cannot decide business risk.

## Live deployment

- Web: `https://datapilotgo.com`
- API: `https://datapilotgo-api.fly.dev`
- Health: `https://datapilotgo-api.fly.dev/health`

The home page separates two honest modes. `/demo` is an instant, build-time replay exported from one independently verified UCI run; it makes no backend or model request. `/workbench` runs the real v0.2 engine and bounded Anthropic integration against uploaded or bundled CSVs. The public API pre-seeds four samples, rate-limits uploads and AI-triggering routes, enforces a persistent daily model-call budget, and removes visitor runs after 24 hours. The three product fixtures are synthetic. `uci_online_retail` is an unmodified 42,481-row public UCI dataset subset with source attribution and CC BY 4.0 licensing recorded in the UI and repository.

## Local development

Requirements: Node.js 22+, Python 3.12+.

```bash
npm install
python3 -m venv .venv
.venv/bin/pip install -e '.[dev]'
cp .env.example .env

make api                         # FastAPI at http://127.0.0.1:8000
make web                         # vinext at http://localhost:3000
```

Demo operations:

```bash
make demo                        # start API + web in booth mode
make demo-reset                  # recreate four contracted samples + one observational run
make demo-prewarm                # warm bounded AI paths and red-team cases
make demo-smoke                  # full API lifecycle against the configured local base
make e2e-smoke                   # real browser flow against already-running services
make golden                      # regenerate engine-owned golden/replay artifacts
make test                        # pytest · Ruff · mypy --strict · oxlint · production build
```

## Runtime configuration

| Variable | Default | Purpose |
|---|---|---|
| `DATAPILOT_DATA_DIR` | `.data` | Persistent run, artifact, cache, and public-budget root. |
| `DATAPILOT_ALLOWED_ORIGINS` | local web origins | Exact CORS allow-list. |
| `DATAPILOT_SYNC_PIPELINE` | unset | Run inline for tests/golden instead of the bounded thread pool. |
| `DATAPILOT_API_TOKEN` | unset | Optional bearer token for `/v1/*`; health stays open. |
| `DATAPILOT_DOCS` | `1` | Set `0` to disable OpenAPI UI publicly. |
| `DATAPILOT_AI_MODE` | `auto` | `auto`, `off`, or deterministic `replay`. |
| `DATAPILOT_AI_CACHE` | `fallback` | `prefer` in public demo mode serves an identical validated request from cache first. |
| `ANTHROPIC_API_KEY` | unset | Server-only secret; never enters frontend bundles or images. |
| `ANTHROPIC_MODEL` | `claude-haiku-4-5-20251001` | Cost-controlled default for the three bounded AI tasks. |
| `ANTHROPIC_BASE_URL`, `HTTPS_PROXY` | unset | Optional official-SDK network routing. |
| `DATAPILOT_PUBLIC_MODE` | `0` | Enables public limits, retention, durable AI budget, and safe health metadata. |
| `DATAPILOT_SEED_SAMPLES` | public-mode default | Creates stable sample runs and asynchronously prewarms analysis. |
| `DATAPILOT_RUN_RETENTION_HOURS` | `24` | Visitor run lifetime; protected public samples are retained. |
| `DATAPILOT_UPLOADS_PER_MINUTE` | `10` | Per-client public upload limit. |
| `DATAPILOT_AI_REQUESTS_PER_HOUR` | `20` | Per-client AI-triggering request limit. |
| `DATAPILOT_AI_DAILY_CALL_CAP` | `40` in `fly.toml` | Persistent global provider-call ceiling; exhaustion falls back honestly. |
| `NEXT_PUBLIC_API_BASE_URL` | local API | Build-time frontend default. Runtime priority is `?api=` → localStorage → build env → localhost. |

## API lifecycle

```text
POST /v1/runs (CSV + optional contract) or POST /v1/runs/from-sample
GET  /v1/runs/{id}/events             persisted SSE pipeline events
GET  /v1/runs/{id}                    report + governance state
PUT  /v1/runs/{id}/decisions          one allowed disposition per finding
POST /v1/runs/{id}/dry-run            typed actions + masked preview + action-set hash
POST /v1/runs/{id}/apply              idempotent, stale revisions/hashes return 409
GET  /v1/runs/{id}/verify             recompute artifact and governance invariants
GET  /v1/runs/{id}/artifacts/...      release, manifests, ledgers, audit bundle
```

Every error uses `{error: {code, message_zh, message_en, retryable, correlation_id}}`; responses carry correlation and server-timing metadata.

## Containers and Fly

```bash
docker compose up --build
flyctl deploy --app datapilotgo-api --config fly.toml --dockerfile Dockerfile.api
```

Secrets are supplied only at runtime. The Fly image includes the UCI bytes and all sample contracts; its persistent volume stores visitor runs, protected sample runs, response cache, and the daily call ledger.

## Truth boundaries

- Facts, AI proposals, policy decisions, human decisions, actions, and validations are separate records.
- Every model call records requested/served model, prompt version, input hash, token usage, latency, redaction summary, cache/fallback status, and grounding result.
- Source artifacts are immutable; quarantine and exclusion alter release membership, never the source or quality denominator.
- Validation failure prevents a released artifact. Replay and cached/live AI states are visibly distinct.
- The booth snapshot is generated by `scripts/export_verified_replay.py`, contains aggregate facts only, and is guarded by source/hash/conservation/privacy tests.
- Exported CSV bytes stay hash-identical to the audited artifact. They are not silently modified for spreadsheet formula safety; import untrusted CSVs using an isolated or formula-disabled workflow.
- Sensitive-data detection is conservative engineering protection, not a certification or regulatory claim.

See [docs/BUILD-SPEC.md](docs/BUILD-SPEC.md), [docs/PRODUCT.md](docs/PRODUCT.md), [docs/DEMO.md](docs/DEMO.md), and [docs/SAMPLES.md](docs/SAMPLES.md).
