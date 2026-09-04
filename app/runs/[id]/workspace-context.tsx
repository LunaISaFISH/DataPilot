'use client';

import { createContext, useContext } from 'react';

import type { ApiError, HealthState, ResponseMeta } from '@/lib/api';
import type { Language } from '@/lib/language';
import type {
  AICallRecord,
  ApplyRequest,
  ArtifactInfo,
  ContractDraftStarted,
  DecisionInput,
  DecisionsResponse,
  DryRunResponse,
  ExecutionResult,
  Finding,
  RedteamCase,
  RedteamResult,
  ReplayCreated,
  RunCreated,
  RunDetail,
  RunEvent,
  SemanticRerunResult,
  TamperTestResult,
  VerifyReport,
} from '@/lib/types';

// The contract between the run console shell (run-workspace.tsx) and every pane under
// sections/. Panes read state and call mutations through `useWorkspace()`; they never call
// lib/api.ts mutation endpoints directly, so the shell can refresh RunDetail after each one.
// See sections/README.md for the pane ownership table.

export type TabId = 'profile' | 'contract' | 'findings' | 'decisions' | 'changeset' | 'release' | 'artifacts';

export const TAB_IDS: readonly TabId[] = ['profile', 'contract', 'findings', 'decisions', 'changeset', 'release', 'artifacts'];

export type TabAvailability = {
  locked: boolean;
  /** Localized reason shown in the tab tooltip and in place of the pane when locked. */
  reason: string | null;
};

export type MutationKey =
  | 'refresh'
  | 'putContract'
  | 'draftContract'
  | 'putDecisions'
  | 'createDryRun'
  | 'applyRun'
  | 'rerunSemantic'
  | 'redteam'
  | 'tamperTest'
  | 'verifyRun'
  | 'replayRun';

export type ApplyOutcome = {
  result: ExecutionResult;
  /** `meta.idempotentReplay` is true when the server returned a stored result for a repeated key. */
  meta: ResponseMeta;
};

export type StreamTransport = 'sse' | 'polling' | null;

export type WorkspaceContextValue = {
  runId: string;
  /** Null until the first `GET /v1/runs/{id}` resolves (or fails, see `loadError`). */
  run: RunDetail | null;
  loadError: ApiError | null;
  /** Every event received so far, ordered by `seq`, deduplicated. */
  events: RunEvent[];
  transport: StreamTransport;
  /** Last stream error (e.g. SSE_UNAVAILABLE when polling). */
  streamError: ApiError | null;
  /** `GET /v1/runs/{id}/ai-ledger`; empty when the endpoint fails or nothing was recorded. */
  ledger: AICallRecord[];
  /** `GET /v1/runs/{id}/artifacts`; empty when the endpoint fails. */
  artifacts: ArtifactInfo[];
  health: HealthState;
  language: Language;
  selectedFindingId: string | null;
  /** The finding matching `selectedFindingId` in the current report, or null. */
  selectedFinding: Finding | null;
  setSelectedFindingId: (findingId: string | null) => void;
  activeTab: TabId;
  setActiveTab: (tab: TabId) => void;
  tabs: Record<TabId, TabAvailability>;
  /** Reload RunDetail, ledger and artifacts. Called automatically after every mutation. */
  refresh: () => Promise<void>;
  busy: Record<MutationKey, boolean>;
  /** Last ApiError thrown by a mutation (panes still receive the throw and render their own guard row). */
  lastError: ApiError | null;
  putContract: (yaml: string) => Promise<RunCreated>;
  draftContract: () => Promise<ContractDraftStarted>;
  putDecisions: (decisions: DecisionInput[]) => Promise<DecisionsResponse>;
  createDryRun: () => Promise<DryRunResponse>;
  applyRun: (body: ApplyRequest) => Promise<ApplyOutcome>;
  rerunSemantic: (findingId: string) => Promise<SemanticRerunResult>;
  redteam: (findingId: string, redteamCase: RedteamCase) => Promise<RedteamResult>;
  tamperTest: () => Promise<TamperTestResult>;
  verifyRun: () => Promise<VerifyReport>;
  replayRun: () => Promise<ReplayCreated>;
};

export const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export function useWorkspace(): WorkspaceContextValue {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error('useWorkspace must be used inside RunWorkspace');
  return value;
}

export const RUNNING_LIFECYCLES: ReadonlySet<string> = new Set(['QUEUED', 'RUNNING']);
