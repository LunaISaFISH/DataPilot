# Product contract

## Positioning

DataPilot is an AI-assisted dataset release gate. It answers whether a tabular dataset can enter analysis, labeling, training, or delivery with evidence that another person can inspect and reproduce.

It is not chat-with-CSV, an arbitrary code executor, an automated imputation product, or a compliance certification.

## Product loop

```text
immutable CSV + Data Contract
→ deterministic ingestion/profile/detectors
→ bounded semantic candidate
→ AI structured proposal or abstention
→ grounding validator
→ policy authorization and human disposition
→ dry run with fixed action-set hash
→ deterministic allowlisted executor
→ post-condition validation
→ candidate/release artifacts + manifests + ledgers
```

Facts, findings, proposals, policy decisions, human decisions, actions, and validation results remain separate contracts. A rejected proposal does not silently close its finding. Every finding must have exactly one legal terminal disposition before release.

## AI contribution and supervision

The provider layer exposes three bounded tasks:

1. semantic mapping into a contract-owned canonical vocabulary;
2. Data Contract drafting for a user to inspect and explicitly adopt;
3. evidence-bound release-brief narration whose claims are checked against report values.

The model receives aggregate candidate tokens, counts, vocabulary, evidence references, and redacted summaries. It receives zero rows, no direct identifiers or free text, no dataframe handle, and no execution capability. Outputs use strict schemas. Backend grounding independently checks observed source values, canonical targets, evidence references, ambiguity registry, allowed actions, sensitive fields, current revision, and affected counts.

Every attempt is written to the AI ledger with provider/model attribution, prompt version, input hash, tokens, latency, redaction envelope, grounding outcome, and cached/fallback state. Timeout, refusal, malformed output, budget exhaustion, or missing evidence fails closed and never masquerades as a model success.

## Data and score invariants

- UTF-8, UTF-8 BOM, and GB18030/GBK CSVs are decoded within fixed limits; original bytes are hashed and retained immutably.
- `record_uid` derives from source hash and logical ordinal, then survives all versions.
- Source, candidate, and release artifacts are distinct. Partial execution never exposes a release artifact.
- Baseline/candidate scores are comparable only under the same record scope, evaluated rule scope, contract hash, score version, and effective weights.
- Quarantine, column exclusion, and duplicate release exclusion never shrink the quality denominator or overwrite source data.
- Release readiness (`BLOCKED`, `CONDITIONAL_PASS`, `PASS`) is independent from quality score; blockers and validation failure override score.
- Dry run and Apply must share the same run revision and approved-action-set hash; retries use idempotency keys.
- CSV downloads preserve audited bytes and hashes. Spreadsheet formula risk is disclosed instead of silently changing the release artifact.

## Demonstration datasets

- `clinical_nlp`: 5,200-row deterministic synthetic golden fixture.
- `ecommerce_orders`: 8,000-row deterministic synthetic fixture with semantic, injection, and sensitive-data cases.
- `hr_roster`: 3,000-row deterministic synthetic fixture with high-sensitivity fields and policy restrictions.
- `uci_online_retail`: 42,481-row unmodified December 2010 subset of the public UCI Online Retail dataset; source DOI, attribution, SHA-256, and CC BY 4.0 are pinned in the repository.

The UI labels synthetic and real public data explicitly. Engine-generated numbers, provider attribution, pipeline events, cached results, and replay state must never be replaced by decorative constants or simulated progress.

## Presentation and live modes

- `/demo` reads a privacy-minimised snapshot exported from one real, completed and independently verified UCI run. It is instant, bilingual, usable without the API, always labelled replay, and never simulates a live pipeline or model call.
- `/workbench` preserves live CSV upload, bundled samples, observational analysis and contracted analysis. Operational API/model status appears only in these live routes.
- Observational runs never construct or schedule an LLM resolver. They use a dedicated executor so provider latency or startup prewarming cannot starve deterministic profiling.
- A historical replay preserves the provider/model recorded at the time of that run; new live calls default to `claude-haiku-4-5-20251001` and remain fully attributed in the ledger.

## Public P0 boundary

The public Fly runtime is a capped recruitment-demo service:

- 25 MiB, 250,000 physical rows, and 200 columns maximum per CSV;
- 10 uploads/minute and 20 AI-triggering requests/hour per client;
- persistent global daily provider-call ceiling (40 calls in the fair deployment) with deterministic fallback;
- visitor run/artifact expiry after 24 hours; protected public samples persist;
- exact CORS allow-list, disabled public API docs, non-secret health status, masked logs, and server-only credentials;
- four stable sample runs created and prewarmed at startup.

This is deliberately a single-user/single-region P0, not multi-tenant storage or distributed processing. The engine boundary, store interface, pure contracts, and job lifecycle leave room for a database/object-store/worker replacement without changing the product semantics.

## Release proof

A successful release includes source/candidate/release hashes, contract and decision hashes, action authorization references, a cell and membership change ledger, validation observations and expectations, model input hashes, and an audit bundle. The offline verifier recomputes these materials and re-runs deterministic execution. A replay is always labelled replay; cached model output is always labelled cached; neither is presented as a fresh live call.
