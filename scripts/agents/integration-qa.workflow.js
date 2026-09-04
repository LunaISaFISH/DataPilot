export const meta = {
  name: 'datapilot-integration-qa',
  description: 'Bring up the real DataPilot v0.2 stack, walk every demo beat end to end, adversarially QA it from four lenses, fix, re-gate, and write the demo script',
  phases: [
    { title: 'Bring-up', detail: 'servers, demo-reset, smoke, first fixes' },
    { title: 'QA', detail: 'four lenses against the live stack' },
    { title: 'Fix', detail: 'backend + frontend fixers, re-gate' },
    { title: 'Docs', detail: 'DEMO.md script, README, TASK' },
  ],
}

const REPO = '/Users/franz/Desktop/DataPilot'
const backendReport = args && args.backendReport ? args.backendReport : '(none)'
const frontendReport = args && args.frontendReport ? args.frontendReport : '(none)'

const COMMON = `
Repository: ${REPO}. Python venv ${REPO}/.venv; Node 22. Read ${REPO}/docs/BUILD-SPEC.md first (it is the authority), then docs/SAMPLES.md.
Servers for this phase: the API runs at http://127.0.0.1:8000 and the web app at http://127.0.0.1:3000 (started by the bring-up agent; check with curl http://127.0.0.1:8000/health and curl -I http://127.0.0.1:3000). If they are down, start them yourself in the background exactly like this and leave them running:
  cd ${REPO} && (DATAPILOT_DATA_DIR=.data DATAPILOT_AI_MODE=auto PYTHONPATH=services/api nohup .venv/bin/uvicorn datapilot.api.main:app --host 127.0.0.1 --port 8000 > .artifacts/api.log 2>&1 &)
  cd ${REPO} && (nohup npm run dev -- --port 3000 > .artifacts/web.log 2>&1 &)
(mkdir -p .artifacts first; vinext dev flag for port may differ — check node_modules/vinext/README.md). An ANTHROPIC_API_KEY is in the environment: live AI calls are real and cost money; do not loop them needlessly (the response cache by input_hash is on). Never print the key.
Browser automation: use playwright-core from node_modules with chromium.launch({ channel: 'chrome', headless: true }) in a .mjs script under .artifacts/ or scripts/; save screenshots under .artifacts/qa/<lens>/. Use the API directly with curl or Python requests-free urllib for API-level checks.
Rules: never run git state-changing commands; never delete .data/ wholesale except through the app's own cleanup endpoint or make demo-reset; report only what you verified with evidence (command + output or screenshot path); when you find a bug, capture the exact reproduction.
Backend build report (public names, measured latencies, known gaps):
${backendReport}
Frontend build report:
${frontendReport}
`

phase('Bring-up')
const bringup = await agent(`${COMMON}
YOUR TASK (Q0, bring-up). You may edit any file in the repo to fix integration bugs (backend and frontend agents have finished).
1. mkdir -p .artifacts; confirm ports 8000/3000 are free (the old docker stack was stopped by the orchestrator; if something still listens, report it and use lsof to identify it — do not kill processes you did not start unless they are the old docker containers, which you may stop with docker compose stop).
2. Run the Python gate quickly: .venv/bin/pytest -q (must pass; if not, fix and note).
3. Start the API and web app as described. Run make demo-reset (or the equivalent commands if the target is missing — then add it per spec §12) and make demo-prewarm; report AI latencies and cache paths.
4. Run scripts/demo_smoke.py (create it per spec §12 if missing: walks create-from-sample → wait for REVIEW_REQUIRED → decisions derived from allowed_outcomes → dry-run → tamper-test → apply → verify → artifacts → every redteam case → brief, for all three samples, asserting shapes and validations; exit 0/1). Fix whatever breaks.
5. Run the Playwright walk scripts/e2e_smoke.mjs (create per spec §12 if missing): open /, start the ecommerce sample with contract, wait for the console to reach REVIEW_REQUIRED via the live event log, open 发现, select the SEM finding, check the AI envelope shows request_payload with rows_sent 0, run a redteam case, go to 处置, choose outcomes with reason chips, save, generate the change set, apply, check the validation table, run 本地复验 and 篡改测试, open 工件 and 重新校验, open the API log drawer. Screenshot each step into .artifacts/e2e/. Fix integration bugs (type mismatches, wrong paths, missing fields) on whichever side is wrong per the spec.
6. Leave both servers running. Report: what was fixed, which beats pass, measured timings (analysis ms per sample, AI latency, apply ms), and anything still broken.`,
  { label: 'Q0:bring-up', phase: 'Bring-up', effort: 'high' })
log('bring-up done')

const FINDINGS = {
  type: 'object', additionalProperties: false, required: ['findings'],
  properties: { findings: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['title', 'area', 'severity', 'repro', 'evidence', 'suggested_fix'],
    properties: { title: { type: 'string' }, area: { type: 'string', enum: ['backend', 'frontend', 'docs', 'ops'] }, severity: { type: 'string', enum: ['blocker', 'major', 'minor'] }, repro: { type: 'string' }, evidence: { type: 'string' }, suggested_fix: { type: 'string' } } } } },
}

phase('QA')
const qaCommon = `${COMMON}
BRING-UP REPORT:
${bringup}
You are a QA REVIEWER: do not edit product code (scratch scripts under .artifacts/ are fine). Severity: blocker = breaks a demo beat or violates a truth boundary or shows fake/mislabelled data; major = wrong behaviour on plausible input or a visibly unprofessional UI state; minor = polish.`
const qa = (await parallel([
  () => agent(`${qaCommon}
LENS A — happy path on all three samples through the UI, both languages. For each sample (with contract): full beat sequence via Playwright with screenshots at 1440×900; verify every number on screen matches the API (fetch RunDetail and compare counts, scores, hashes); verify the header contrast 质量分 vs 发布状态; verify lifecycle rail states and event log messages are real (no client-side timers: search the frontend bundle/source for setTimeout/setInterval usages that fake progress); verify downloads work and 本地复验 matches; verify the observational path (sample without contract) shows 仅观测模式 and the AI contract draft flow completes with accepted and rejected rules; toggle language and check no English leaks into primary zh copy except mono identifiers.`,
    { label: 'QA:A-happy-path', phase: 'QA', schema: FINDINGS, effort: 'high' }),
  () => agent(`${qaCommon}
LENS B — hostile inputs and guard states through the UI and API: GB18030 CSV (build one with Python: encode a Chinese CSV as gb18030) → encoding badge; a CSV with quoted newlines; a 1-column CSV; a 250-column CSV; a non-CSV file; a contract YAML with unknown columns / invalid YAML / oversized; 409 flows: dry-run before decisions, apply after changing a decision (stale), apply twice same key (X-Idempotent-Replay), apply with wrong hash; tamper-test then a real apply still works; every redteam case including LIVE_INJECTION and TIMEOUT; rerun semantic on a finding; replay determinism strip equality; verify endpoint after apply; delete run then open its URL; server restart mid-run (kill uvicorn after a run reached REVIEW_REQUIRED, restart, confirm the console still loads it with decisions); SSE reconnect (throttle by killing and restarting the API while the console is open). Check API error bodies never include stack traces or raw sensitive values.`,
    { label: 'QA:B-hostile', phase: 'QA', schema: FINDINGS, effort: 'high' }),
  () => agent(`${qaCommon}
LENS C — visual and UX review as a skeptical senior engineer at a booth. Screenshots at 1280×800, 1440×900, 1920×1080 with browser zoom 100% and 125% (page.setViewportSize + CSS zoom or deviceScaleFactor) of: /, /runs, /engine, /runs/{id} in every tab and with a finding selected, the API log drawer expanded, the replay page. Judge: does anything still read as a mockup (hero copy, decorative icons, tinted pill walls, empty placeholder text, 'TODO', lorem, inconsistent spacing, misaligned numbers, truncated Chinese, overflowing tables, unreadable 12px on 125%)? Contrast ≥ 4.5:1 for text; equality underlines on identical hashes visible; every AI element has a provenance mark; deterministic fallbacks labelled. Check keyboard navigation in the findings table and focus rings. Report concrete file/component-level fixes.`,
    { label: 'QA:C-visual', phase: 'QA', schema: FINDINGS, effort: 'high' }),
  () => agent(`${qaCommon}
LENS D — AI honesty and safety audit against the live stack. For a completed ecommerce run: pull /v1/runs/{id}/ai-ledger and check every record: request_payload contains no row-level data, no sensitive values (grep for the planted phones/emails/IDs from docs/SAMPLES.md and the remark canary sentence), rows_sent 0, request_bytes matches len(json), input_hash matches sha256 of canonical JSON (recompute in Python using datapilot.serialization.canonical_json); model_served and tokens present for anthropic records; statuses correct. Cross-check the UI: every element with the AI mark maps to a ledger record; every 确定性 mark corresponds to a fallback status; the brief's claims: recompute the number-token verification yourself and confirm unverified claims are struck through; the contract draft's rejected rules have real reason codes and the accepted YAML parses; the redteam results are stored under runs/<id>/redteam and excluded from /verify; the city injection canary reached the model as a JSON string only (inspect request_payload) and whatever the model did, no action maps to a target outside the vocabulary; the permission card content equals the prompts/schemas in services/api/datapilot/ai/prompts.py. Also review README/BUILD-SPEC/UI copy for any claim the system does not actually enforce.`,
    { label: 'QA:D-ai-honesty', phase: 'QA', schema: FINDINGS, effort: 'high' }),
])).filter(Boolean)
const findings = qa.flatMap((r) => r.findings)
log(`${findings.length} QA findings (${findings.filter((f) => f.severity === 'blocker').length} blockers)`)

phase('Fix')
const backendFindings = findings.filter((f) => f.area === 'backend' || f.area === 'ops')
const frontendFindings = findings.filter((f) => f.area === 'frontend' || f.area === 'docs')
const fixes = await parallel([
  () => agent(`${COMMON}
YOUR TASK (X1, backend fixer). You own services/, tests/, scripts/, fixtures/, Makefile, pyproject.toml, docs/SAMPLES.md, docs/BUILD-SPEC.md. Fix these verified findings (blockers and majors mandatory, minors when cheap), each with a regression test where feasible:
${JSON.stringify(backendFindings, null, 1)}
Then run .venv/bin/pytest -q && .venv/bin/ruff check services tests conftest.py scripts && .venv/bin/mypy services/api/datapilot. If engine output changed, regenerate golden (DATAPILOT_AI_MODE=replay) and keep docs truthful. Restart the API server afterwards (kill the uvicorn you find on 8000 that was started by this workflow, start it again the same way) so the frontend fixer tests against the fixed backend. Report per finding: fixed / not-real (with proof) / deferred (why).`,
    { label: 'X1:backend-fix', phase: 'Fix', effort: 'high' }),
  () => agent(`${COMMON}
YOUR TASK (X2, frontend fixer). You own app/, lib/, components/, public/. Fix these verified findings (blockers and majors mandatory, minors when cheap):
${JSON.stringify(frontendFindings, null, 1)}
Then run npx tsc --noEmit -p tsconfig.json && npm run lint && npm run build, and re-run scripts/e2e_smoke.mjs against the live stack (the backend fixer may restart the API; retry once if a request fails during restart). Report per finding: fixed / not-real / deferred.`,
    { label: 'X2:frontend-fix', phase: 'Fix', effort: 'high' }),
])
const regate = await agent(`${COMMON}
FIX REPORTS:
${JSON.stringify(fixes, null, 1)}
YOUR TASK (X3, final gate). Run make test (all five gates) and scripts/demo_smoke.py and scripts/e2e_smoke.mjs against the live stack; fix any remaining failure in whichever file it lives (you own the whole repo for this step, except do not change git state). Then produce a final status table: gate → pass/fail with the summary line; beats → pass/fail; measured timings; the list of anything still deferred. Leave both servers running.`,
  { label: 'X3:regate', phase: 'Fix', effort: 'high' })

phase('Docs')
const docs = await agent(`${COMMON}
FINAL GATE REPORT:
${regate}
YOUR TASK (D1, docs). You own docs/DEMO.md (rewrite), docs/TASK.md (rewrite status), README.md (refresh: run instructions incl. make demo / demo-reset / demo-prewarm, env table incl. ANTHROPIC_BASE_URL/HTTPS_PROXY/DATAPILOT_AI_MODE/DATAPILOT_AI_CACHE/DATAPILOT_DOCS, truth boundaries kept and extended with the AI ledger/grounding/redaction guarantees, quality gate), docs/PRODUCT.md (align layering with v0.2), CLAUDE.md (new, short: how to run gates, spec location, rules for agents from BUILD-SPEC §11).
docs/DEMO.md must be the booth script in Chinese: 3-minute main path with beats (≈ 开场规矩 → 上传与反差 → AI 的视野与真调用 → 红队 → 人来拍板/系统也拒绝人 → 预演/应用/验证 → 篡改测试 → 拿走证据), each beat = what to click, what the screen shows, one or two spoken lines (two variants for AI beats: 弃权 vs 映射, 拦下 vs 通过), and why it lands; encores (终端篡改 with the exact safe commands, 幂等, 断网兜底 via TIMEOUT case, 换个文件 with the other samples and the contract-draft flow on an observational run, 看一条记录, verify CLI); fallbacks ladder (cached AI → screen recording → public replay, each honestly labelled); the scale-question card (explicit bounds, Python-loop detectors, measured timings from the final gate report); rehearsal checklist (make demo-reset, make demo-prewarm, scripts/demo_smoke.py, hotspot/proxy test, external display 125%, DevTools closed, uvicorn without reload bound to 127.0.0.1, docs disabled); a numbers table pulled from the regenerated golden report and the sample docs (never invented — read fixtures/*/golden or run the API). State plainly that the public site datapilotgo.com still serves the old replay until the owner redeploys.
Verify every command you document actually works by running it.`,
  { label: 'D1:docs', phase: 'Docs', effort: 'high' })

return { bringup, findings, fixes, regate, docs }
