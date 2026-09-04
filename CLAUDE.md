# DataPilot repository guide

`docs/BUILD-SPEC.md` is the authority for v0.2. Preserve the product thesis: AI proposes; policy decides; humans decide high-risk; deterministic rules execute; validations gate release.

## Before changing code

1. Read `docs/HANDOFF.md`, `docs/BUILD-SPEC.md`, `docs/PRODUCT.md`, and `docs/TASK.md`.
2. Inspect `git status --short --branch`; preserve unrelated worktree changes.
3. Reuse repository helpers for canonical JSON/atomic writes, hashes, Wilson intervals, matching, score aggregation, and credential filtering. Do not add duplicate utilities or re-export-only package initializers.
4. Never print or commit secrets. Anthropic credentials belong in the server environment only.

## Verification

```bash
make test
make demo-reset
make demo-prewarm
.venv/bin/python scripts/demo_smoke.py --base http://127.0.0.1:8000 --sample uci_online_retail --timeout 180
node scripts/e2e_smoke.mjs --web http://localhost:3000
```

Run the smallest relevant test while editing, then `make test` at a milestone. Python is strict-mypy and Ruff clean; frontend uses oxlint and a production vinext build. Keep shared pytest setup in `conftest.py` rather than copying setup among test files.

## Non-negotiable truth boundaries

- No hard-coded result counts, fake pipeline animation, hidden authorization, or replay presented as live.
- AI receives aggregate/redacted envelopes only, never raw rows or sensitive values; it never creates executable code or writes a dataframe.
- Recompute proposal counts server-side and require schema, grounding, policy, human decision when required, deterministic execution, and validation in that order.
- Source artifacts and metadata are immutable. Quarantine/exclusion changes release membership, not source rows or score scope.
- AI provider, model, tokens, latency, input hash, cache/fallback reason, redactions, and grounding outcome remain visible in the ledger.
- Validation failure or unresolved blocker must prevent release artifacts.
- Preserve audit-identical CSV bytes. Warn about spreadsheet formula execution rather than silently rewriting a hashed download.

## AI cost discipline

Use replay/fake providers for normal tests. Use cached public sample requests for rehearsal. Make a live Anthropic call only when validating provider integration or output quality, and record it in the ledger. `claude-opus-5` is required by BUILD-SPEC; keep effort low except contract drafting, and rely on the public persistent daily cap.

## Deployment and git

- API deploy: `flyctl deploy --app datapilotgo-api --config fly.toml --dockerfile Dockerfile.api`.
- Web uses the existing OpenAI Site and `NEXT_PUBLIC_API_BASE_URL=https://datapilotgo-api.fly.dev`; never create a duplicate Site.
- Do not expose Fly secret values. Public status may show only availability and counters.
- Direct work happens on `main`. Do not commit until the owner approves. Author approved commits as `LunaISaFISH <65061532+LunaISaFISH@users.noreply.github.com>`; never use an AI/bot identity.
