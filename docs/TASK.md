# Current task

Updated: 2026-09-05 (Asia/Singapore)

## Current state

- Branch `main`; the substantive v0.2 release was committed and pushed as `7a1a607` with the confirmed Luna Git identity.
- Existing web identity and domain are reused: `https://datapilotgo.com`. No duplicate Site was created.
- Existing API app is reused: `https://datapilotgo-api.fly.dev`; the Fly secret name `ANTHROPIC_API_KEY` is present and its value was not printed.
- API engine `0.2.0` and the redesigned public Site are live. `/health` reports the new `claude-haiku-4-5-20251001` default.

## Implemented in this worktree

- Replaced the dense sidebar/PPT-like entry screen with a quiet top navigation, compact landing page, and a focused live workbench.
- Added `/demo`, a four-step bilingual booth experience sourced from a privacy-minimised snapshot of a real APPLIED UCI run. It loads without `/health`, `/v1`, or an LLM call and is always labelled as replay.
- Added `scripts/export_verified_replay.py`. It verifies the source, contract, score scope/version, dispositions, row reconciliation, validations, independent `/verify` checks, and AI-ledger references before atomically writing the snapshot.
- Added replay privacy/conservation tests. No source rows, record UIDs, request/response payloads, or distinct examples are published.
- Fixed browser run refresh by subscribing to FastAPI's named `run_event` SSE events and falling back to polling immediately after a previously open stream drops.
- Isolated observational jobs from contracted/AI jobs. No-contract analysis receives no AI resolver and records an empty AI ledger; completed persisted reports can recover a terminal lifecycle safely after restart.
- Reduced the new live default from Opus to `claude-haiku-4-5-20251001`; preserved the historical model identity in the frozen replay ledger. Fly's persistent daily cap is 40 calls.
- Simplified mobile run pages so lifecycle/log/AI rails do not stack ahead of the core workspace. The 390px replay path has no horizontal overflow.
- Updated the real-browser smoke to prove: zero API calls in booth replay, UCI observational completion, contracted run through apply, 14/14 validations, bilingual mobile rendering, and no horizontal overflow.

## Verified

- `make test`: 283 pytest tests passed; Ruff, mypy across 38 source files, oxlint, and production vinext build passed.
- Local Playwright flow passed against a replay-mode API and the current frontend, including repeated UCI quick scans under 0.4 seconds and the full contracted release.
- In-app mobile-browser QA passed in English and Chinese: all four replay stages, zero replay API requests, collapsed live samples, public observational completion, and no horizontal overflow at 390 × 844.
- Public deployment QA passed on `https://datapilotgo.com`: the custom domain serves the new landing page, `/demo` completes all four stages in both languages with zero API calls, and `/workbench` completed a real UCI observational run.
- A minimal live smoke passed with `claude-haiku-4-5-20251001`: the semantic call returned a grounded mapping in 7.9 s (1,279 input / 191 output tokens); contract drafting returned in 14.2 s (2,542 / 1,069), and the validator rejected one unsupported format rule. Haiku-specific request construction omits unsupported `effort` and server-side `fallbacks` parameters.
- `flyctl config validate` passed. `Dockerfile.api` built successfully and the resulting container returned `/health` with engine `0.2.0`, AI mode `off`, and four samples.
- Snapshot facts: 42,481 × 8 real UCI records; 7 findings; 89.43 → 95.92 fixed-scope score; 25,653 eligible; 16,341 quarantined; 487 release-excluded; 14/14 validations; `CONDITIONAL_PASS`.
- Snapshot source SHA-256 matches `fixtures/uci_online_retail/online_retail_2010_12.csv`; independent run verification contains 10/10 passing checks.

## Release status

- Public web: `https://datapilotgo.com`
- Instant booth replay: `https://datapilotgo.com/demo`
- Real analysis: `https://datapilotgo.com/workbench`
- Public API: `https://datapilotgo-api.fly.dev`
- Remaining operator action: rotate the Anthropic key before the recruitment fair if the key mentioned in the historical security note has not already been replaced.

## Known limits

- The public backend is one Fly machine with a persistent local filesystem, not multi-region or multi-tenant production infrastructure.
- P0 accepts CSV up to 25 MiB, 250,000 physical rows, and 200 columns.
- The booth snapshot proves a pinned completed run; it is not evidence that a new provider call is happening now. Live provider and fallback states remain visible in the workbench ledger.
- Historical replay provenance names the model actually used for that run; it must not be rewritten to match the new cheaper default.
