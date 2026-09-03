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

## Next

1. Commit and push the integrated P0 slice.
2. Run the opt-in Anthropic Haiku smoke and one explicit Sonnet quality sample.
3. Deploy the Sites frontend and run production smoke tests.
4. Deploy the live FastAPI container if a compatible authenticated runtime is available;
   otherwise keep the public deployment truthfully limited to verified replay and document the
   single runtime credential blocker.

## Deployment

Not deployed. An older Site identity was not found in the accessible workspace.
