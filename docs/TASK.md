# Current task

## Status

- Branch: `main`
- Repository started from an empty remote.
- Sites capability scaffold created with UI primitives, D1, R2, and authenticated-route support.
- Python contracts, deterministic synthetic fixture, Polars engine, policy decisions, dry run,
  deterministic executor, validation gate, artifacts, and synchronous API are implemented.
- The bilingual mobile dashboard supports live CSV + YAML upload and a complete verified replay.
- Replay state restores safely; offline assets, cleaned CSV, manifest, report, and social preview
  are generated from engine output.
- Local verification: 24 pytest tests, Ruff, strict mypy, frontend lint, production build, full
  390x844 Chinese flow, and real 5,200-row browser upload all pass.
- Docker Compose builds both services and starts a healthy API plus a working Web container.

## Next

1. Grant the current GitHub account write access (or authenticate the repository owner), then push
   the existing local commits.
2. Run the opt-in Anthropic Haiku smoke and one explicit Sonnet quality sample from repository
   secrets.
3. Attach a protected FastAPI runtime URL when deployment credentials are available.

## Deployment

The existing owner-only Site `DataPilot Clinical Review` was recovered and deployed at
`https://datapilot-clinical-review.franzxu28.chatgpt.site`. Production smoke checks pass for the
dashboard, replay, reports, cleaned CSV, and release manifest. The hosted preview is deliberately
replay-only until a protected FastAPI runtime is attached; the complete live product runs locally
through Docker Compose.

GitHub synchronization and the repository-secret LLM smoke are blocked because the currently
authenticated GitHub account has read-only access to `LunaISaFISH/DataPilot`. No alternative remote
or unapproved model spending was used.
