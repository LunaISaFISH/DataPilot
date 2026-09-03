# Product contract

## Positioning

DataPilot is an AI-assisted dataset release gate. It answers whether a dataset can enter a
downstream analysis, labeling, training, or delivery workflow with defensible evidence.

The product is not a chat-with-CSV surface and does not execute generated Python or SQL.

## Layering

1. **Observed fact** — computed by a deterministic profiler or detector.
2. **Finding** — a reviewable problem grounded in facts.
3. **Proposal** — a bounded recommendation, not yet authorized.
4. **Policy decision** — deterministic risk and authorization result.
5. **Human decision** — explicit disposition when policy requires it.
6. **Approved action** — typed, allowlisted, deterministic operation.
7. **Validation** — required post-conditions that gate publication.

Processing lifecycle and release status are independent. A run may be in review while its
release status remains blocked.

## Data and score invariants

- `record_uid` derives from source hash and logical record ordinal, then survives into all
  derived versions.
- Source, candidate, and release artifacts are distinct.
- Baseline and candidate quality are comparable only under the same record scope, evaluated
  field/rule scope, policy hash, score version, and effective weights.
- Quarantine and release exclusion do not shrink the quality-score denominator.
- Blockers override score.

## P0 security

Only UTF-8 CSV is accepted. Upload and policy sizes are bounded. Sensitive-value preflight
occurs before semantic payload construction or profile persistence. Public hosting exposes the
verified synthetic replay; live uploads require a protected deployment boundary.

