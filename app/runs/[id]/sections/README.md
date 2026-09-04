# Run console panes — contract between modules

`app/runs/[id]` is the run console (spec §9.2). The shell (`run-workspace.tsx`) owns data loading,
the event stream and every mutation; panes under `sections/` are pure consumers of
`useWorkspace()` from `../workspace-context.tsx`. Panes never call `lib/api.ts` mutation endpoints
directly — they go through the context so the shell can refresh `RunDetail`, the ledger and the
artifact list after each call. Read-only GETs that are pane-local (`getFindingRecords`,
`getContractDraft`, `getBrief`, `getAiContract`, `getRun` of another run) may be called directly;
every request is recorded in the API log automatically.

## Ownership

| File | Owner | Status |
|---|---|---|
| `../page.tsx`, `../run-workspace.tsx`, `../workspace-context.tsx` | F3a | done |
| `header-strip.tsx`, `lifecycle-rail.tsx`, `event-log-panel.tsx`, `tabs.tsx` | F3a | done |
| `profile-tab.tsx`, `contract-tab.tsx`, `artifacts-tab.tsx` | F3a | done |
| `ai-supervision-rail.tsx`, `api-log-drawer.tsx` | F3a | done |
| `findings-tab.tsx`, `finding/*.tsx` | F3b | done |
| `finding-inspector.tsx` | F3b | done |
| `decisions-tab.tsx` | F3b | done |
| `changeset-tab.tsx`, `release/*.tsx` | F3c | done |
| `release-tab.tsx` | F3c | done |

All panes are in place. Keep the exported names and signatures below when changing a pane; do not
edit `tabs.tsx` or `run-workspace.tsx` to wire one — they import the panes by name.

## Exported signatures the shell expects

```ts
export function FindingsTab(): React.JSX.Element | null;        // sections/findings-tab.tsx
export function DecisionsTab(): React.JSX.Element | null;       // sections/decisions-tab.tsx
export function ChangesetTab(): React.JSX.Element | null;       // sections/changeset-tab.tsx
export function ReleaseTab(): React.JSX.Element | null;         // sections/release-tab.tsx
export function FindingInspector(props: { findingId: string }): React.JSX.Element | null;
```

Tabs are mounted inside `<TabsContent>` only when active and unlocked (inactive panes unmount, so
keep pane-local state recoverable from the server or lift it into the context if it must survive
a tab switch). `FindingInspector` is mounted in the right pane whenever `selectedFindingId` is
non-null and must offer a close control that calls `setSelectedFindingId(null)`.

## Context (`useWorkspace()`)

```ts
type WorkspaceContextValue = {
  runId: string;
  run: RunDetail | null;                 // null until GET /v1/runs/{id} resolves
  loadError: ApiError | null;
  events: RunEvent[];                    // ordered by seq, deduplicated
  transport: 'sse' | 'polling' | null;
  streamError: ApiError | null;
  ledger: AICallRecord[];                // GET /ai-ledger, [] on failure
  artifacts: ArtifactInfo[];             // GET /artifacts, [] on failure
  health: HealthState;                   // useHealth(30 s): { health, error, loading, checkedAt, refresh }
  language: Language;
  selectedFindingId: string | null;
  selectedFinding: Finding | null;       // resolved from run.report.findings
  setSelectedFindingId(id: string | null): void;
  activeTab: TabId;                      // 'profile'|'contract'|'findings'|'decisions'|'changeset'|'release'|'artifacts'
  setActiveTab(tab: TabId): void;
  tabs: Record<TabId, { locked: boolean; reason: string | null }>;
  refresh(): Promise<void>;
  busy: Record<MutationKey, boolean>;    // one flag per mutation below plus 'refresh'
  lastError: ApiError | null;            // last mutation ApiError (panes still get the throw)

  putContract(yaml: string): Promise<RunCreated>;                 // restreams events; revision+1
  draftContract(): Promise<ContractDraftStarted>;                 // restreams events
  putDecisions(decisions: DecisionInput[]): Promise<DecisionsResponse>;
  createDryRun(): Promise<DryRunResponse>;
  applyRun(body: ApplyRequest): Promise<{ result: ExecutionResult; meta: ResponseMeta }>;
  rerunSemantic(findingId: string): Promise<SemanticRerunResult>;
  redteam(findingId: string, case: RedteamCase): Promise<RedteamResult>;
  tamperTest(): Promise<TamperTestResult>;                        // in-memory; nothing written
  verifyRun(): Promise<VerifyReport>;
  replayRun(): Promise<ReplayCreated>;
};
```

Mutation semantics:

- Each helper sets `busy[key]` for its duration, refreshes `run`/`ledger`/`artifacts` afterwards
  (also after a refusal, because a 409 means the server state moved), records the `ApiError` in
  `lastError`, and **re-throws** it. Panes catch and render `<GuardRow error={e} />` from
  `sections/guard-row.tsx` inline where the action was triggered — never a toast.
- `applyRun` sends the `Idempotency-Key` header and body key; `meta.idempotentReplay` is true
  when the server answered with `X-Idempotent-Replay: true`. Generate keys with
  `newIdempotencyKey()` from `lib/api.ts` and keep the same key while retrying one apply.
- `ApiError` carries `code`, `message_zh/en`, `status`, `correlation_id`, and `observed`/`expected`
  for governance 409 bodies. `GuardRow` renders observed/expected side by side (HashChip when the
  value is a digest). `ObservedValue` and `isHashLike` are exported for validation tables.

## Lock rules (computed in `run-workspace.tsx`)

| Tab | Unlocked when |
|---|---|
| 画像 profile | `run.report` exists |
| 契约 contract | lifecycle not QUEUED/RUNNING (contract drafting lives here) |
| 发现 findings | report exists and lifecycle not QUEUED/RUNNING |
| 处置 decisions | report exists, lifecycle not OBSERVATIONAL/QUEUED/RUNNING |
| 变更集 changeset | `run.dry_run` exists (F3b's 处置 pane owns the 生成变更集 button) |
| 验证与发布 release | `run.dry_run` or `run.execution` exists (tamper test and 应用 state may render before apply) |
| 工件 artifacts | run loaded |

Default tab is 发现 when a report exists, otherwise 画像; a user's choice persists for the page.

## Right pane

- No selection → `AiSupervisionRail` (permission card from `GET /v1/ai/contract`, ledger table,
  budget `calls used / max_calls_per_run`, provider/mode from `/health`). Clicking a ledger row
  with a `finding_id` selects that finding.
- Selection → `FindingInspector({ findingId })`. The ledger record for a finding is
  `ledger.find(r => r.call_id === finding.proposal?.ledger_call_id)`; `request_payload` /
  `response_payload` / `request_bytes` / `redaction` are the 发送 / 返回 envelope fields.

## Event stream

`subscribeEvents` (lib/api.ts) tails SSE and falls back to polling `getRun` every 2 s after two
EventSource errors. In polling mode no new `RunEvent`s arrive (there is no non-SSE events
endpoint); `run` still refreshes via `onPoll`. Mutations flagged `restream` re-subscribe with
`after = lastSeq` so a pipeline started after polling stopped is tailed again. Every
COMPLETED/FAILED event schedules a coalesced `refresh()`.

## API log

`lib/api-log.ts` keeps the last 200 requests (`useApiLog()`): method, path, status, `Server-Timing`
total, client ms, `X-Correlation-Id`, `X-Idempotent-Replay`, request/response bodies (JSON,
truncated at 64 KiB; multipart bodies are described by field name/size only). SSE open/error/
polling transitions are logged as `SSE` rows. The backend must expose the three headers via
`Access-Control-Expose-Headers` for them to be readable cross-origin.

## Shared helpers

- `sections/guard-row.tsx`: `GuardRow`, `ObservedValue`, `isHashLike`.
- `sections/header-strip.tsx`: `aiCounters(findings, ledger)` (提议/弃权/被拒 derivation).
- `sections/lifecycle-rail.tsx`: `deriveRailStates(run, events, artifacts, ledger, t)`.
- `sections/event-log-panel.tsx`: `EventLogPanel({ mode: 'rail' | 'prominent' })`.
- `lib/hash.ts`: `sha256Hex(ArrayBuffer)` for 本地复验 on downloaded bytes only.
- Labels: `label('validation' | 'grounding_reason' | 'ai_status' | 'ai_task' | ..., value, language)`
  from `lib/labels.ts`; finding titles/explanations always from `title_zh/en`, `explanation_zh/en`.
