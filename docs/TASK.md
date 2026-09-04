# Current task

Updated: 2026-09-04 (Asia/Singapore)

## Delivered

- Branch `main`; current committed base `f187d95df588`, one commit ahead of `origin/main` before this working set.
- Real v0.2 frontend/backend integration completed for clinical, e-commerce, HR, and UCI samples; observational upload and AI-assisted contract drafting also exercised.
- Demo operations exist: `make demo-reset`, `make demo-prewarm`, `scripts/demo_smoke.py`, and `scripts/e2e_smoke.mjs`.
- Three backend adversarial reviews completed. Fixes cover immutable source/meta protection, recoverable apply state, masked business keys, score consistency, honest fallback attribution, concurrent daily-call reservation, safe YAML errors, and formula-risk disclosure.
- Public mode implements per-client upload/AI limits, persistent global AI budget, 24-hour visitor cleanup, protected sample seeds, and startup prewarm. The frontend supports safe runtime backend switching.
- Fly app `datapilotgo-api` is live in `nrt` on machine `683615ebee7668`, image `deployment-01M1PBDPV0XJ056PE5EWWHM0Y7`; health check is passing and the 3 GB `datapilot_data` volume is attached.
- Public UCI smoke passed end to end: 42,481 records, 7 findings, source score 89.43, grounded Anthropic `EIRE → Ireland` mapping across an engine-recounted 403 records, candidate score 95.92, 25,653 eligible, 16,341 quarantined, 487 excluded from the release package, 14/14 validations, final `CONDITIONAL_PASS`, and offline verify success.
- Public web-to-Fly CORS connection was browser-tested through the runtime `?api=` override.

## Verification

- Final full local gate: 271 pytest tests, Ruff, mypy `--strict` across 38 source files, oxlint, and production frontend build all passed.
- Deployment-specific coverage includes installed-container fixture resolution and public runtime limiting.
- `docs/SAMPLES.md` and the frozen clinical replay agree with `fixtures/clinical_nlp/golden/report.json`: 99.27 → 99.61, 9 findings, 316 transformed cells, 56 quarantined, 43 duplicate release exclusions, 5,101 eligible, 14/14 validations.

## Deployment state

- API: `https://datapilotgo-api.fly.dev`; `/health` reports engine/API 0.2.0, Anthropic ready, public mode enabled, four protected seeds, writable storage, and non-secret budget counters.
- Model secret name is present in Fly; its value was never printed by this work.
- Frontend: existing `https://datapilotgo.com` still serves the prior Sites build until the owner rebuilds the existing Site with `NEXT_PUBLIC_API_BASE_URL=https://datapilotgo-api.fly.dev`.
- Current Fly image was built from the reviewed working tree before a final git commit. After owner approval, commit as `LunaISaFISH <65061532+LunaISaFISH@users.noreply.github.com>`, push, and optionally redeploy to bind the public runtime to that immutable revision.

## Remaining owner actions

1. Approve or decline the prepared git commit; no commit has been created without approval.
2. Push `main` after the approved commit.
3. Rebuild the existing OpenAI Site with the public API environment parameter; do not create a second Site.
4. On the event morning run the checklist in `docs/DEMO.md`, including phone-network smoke and prewarming.

## Known limits

- Public demo is a single Fly machine and local filesystem store, not a multi-region or multi-tenant production service.
- Current P0 input boundary is CSV ≤ 25 MiB, ≤ 250,000 physical rows, and ≤ 200 columns.
- Browser runtime API override is intentionally restricted to credential-free HTTP(S) origins.
- The deterministic fallback preserves safety and availability but may produce different UCI release membership because the 403-cell semantic mapping is withheld.
