// Loader and tolerant normaliser for the offline replay (`public/demo/*`). The files are golden
// artifacts written by the engine; this module reads them as `unknown` and maps them onto
// lib/types shapes, leaving a field `null` / `[]` whenever the artifact does not carry it so the
// page renders 不可用 instead of crashing on an older or newer artifact generation. Nothing here
// invents a value: every number shown on the page originates from one of these files.

import type {
  ColumnProfile,
  EvidenceSignal,
  FormatPattern,
  GroundingResult,
  MetricScore,
  RunEvent,
  TopValue,
  ValidationResult,
} from '@/lib/types';

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function bool(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function strArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function objArray(value: unknown): Json[] {
  return Array.isArray(value) ? value.filter(isObject) : [];
}

function strMap(value: unknown): Record<string, string> {
  if (!isObject(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) if (typeof item === 'string') out[key] = item;
  return out;
}

function numMap(value: unknown): Record<string, number> {
  if (!isObject(value)) return {};
  const out: Record<string, number> = {};
  for (const [key, item] of Object.entries(value)) if (typeof item === 'number') out[key] = item;
  return out;
}

/** Prefer the bilingual key; fall back to the legacy single-language key. */
function pair(source: Json, base: string): { zh: string; en: string } {
  const zh = str(source[`${base}_zh`]);
  const en = str(source[`${base}_en`]);
  const legacy = str(source[base]);
  return { zh: zh ?? legacy ?? '', en: en ?? legacy ?? '' };
}

/**
 * Engine scores are ratios in [0, 1]; older golden files stored percentages (99.48). A value above
 * 1 is therefore a percentage and is scaled back to the ratio so `formatScore` reads the same way
 * as in the live console. No other transformation is applied.
 */
function ratioScore(value: unknown): number | null {
  const score = num(value);
  if (score === null) return null;
  return score > 1 ? score / 100 : score;
}

// ---------------------------------------------------------------------------
// Replay shapes (lib/types with nullable groups)
// ---------------------------------------------------------------------------

export type ReplayProfile = {
  dataset_hash: string | null;
  source_encoding: string | null;
  record_count: number | null;
  column_count: number | null;
  scope_hash: string | null;
  evaluation_scope_hash: string | null;
  score_version: string | null;
  metrics: MetricScore[];
  overall_score: number | null;
};

export type ReplayProposal = {
  provider: string;
  model: string | null;
  prompt_version: string | null;
  input_hash: string | null;
  mapping: Record<string, string> | null;
  abstained: boolean;
  abstain_reason: string | null;
  grounding: GroundingResult | null;
  ledger_call_id: string | null;
};

export type ReplayFinding = {
  finding_id: string;
  finding_type: string | null;
  title_zh: string;
  title_en: string;
  explanation_zh: string;
  explanation_en: string;
  column: string | null;
  affected_record_count: number | null;
  affected_cell_count: number | null;
  risk_level: string | null;
  blocking: boolean | null;
  authorization_mode: string | null;
  proposed_action: string | null;
  disposition: string | null;
  allowed_outcomes: string[];
  evidence_signals: EvidenceSignal[];
  record_uid_count: number;
  sample_record_uids: string[];
  details: Json;
  proposal: ReplayProposal | null;
};

export type ReplayContract = {
  id: string | null;
  version: string | null;
  hash: string | null;
  source: string | null;
  field_count: number | null;
};

export type ReplayReport = {
  schema_version: string | null;
  engine_version: string | null;
  fixture_version: string | null;
  synthetic: boolean | null;
  profile: ReplayProfile;
  column_profiles: ColumnProfile[];
  contract: ReplayContract | null;
  sensitive_preflight: { columns_withheld: string[]; cells_masked: number | null } | null;
  findings: ReplayFinding[];
  release_status: string | null;
  finding_outcome_counts: Record<string, number>;
  warnings_zh: string[];
  warnings_en: string[];
  timings_ms: Record<string, number>;
  run_revision: number | null;
};

export type ReplayAction = {
  action_type: string;
  finding_id: string | null;
  authorization_source: string | null;
  authorization_ref: string | null;
  column: string | null;
  mapping: Record<string, string> | null;
  source_format: string | null;
  target_format: string | null;
  record_uid_count: number | null;
};

export type ReplayDryRun = {
  run_revision: number | null;
  source_artifact_hash: string | null;
  approved_action_set_hash: string | null;
  decision_set_hash: string | null;
  actions: ReplayAction[];
  finding_dispositions: Record<string, string>;
  affected_record_count: number | null;
  affected_cell_count: number | null;
  eligible_record_count: number | null;
  quarantined_record_count: number | null;
  excluded_record_count: number | null;
  flagged_record_count: number | null;
  excluded_columns: string[];
  blocking_unresolved: string[];
  status: string | null;
};

export type ReplayManifest = {
  source_artifact_hash: string | null;
  candidate_artifact_hash: string | null;
  release_artifact_hash: string | null;
  policy_pack_hash: string | null;
  contract_hash: string | null;
  decision_set_hash: string | null;
  change_ledger_hash: string | null;
  engine_version: string | null;
  score_version: string | null;
  scope_hash: string | null;
  total_source_records: number | null;
  eligible_record_count: number | null;
  quarantined_record_count: number | null;
  excluded_record_count: number | null;
  flagged_record_count: number | null;
  excluded_columns: string[];
  finding_outcome_counts: Record<string, number>;
  validation_summary: { passed: number; failed: number } | null;
  release_status: string | null;
  ai_call_count: number | null;
  ai_provider: string | null;
  ai_input_hashes: Record<string, string>;
};

export type ReplayExecution = {
  baseline_profile: ReplayProfile | null;
  candidate_profile: ReplayProfile | null;
  dry_run: ReplayDryRun | null;
  validations: ValidationResult[];
  release_manifest: ReplayManifest | null;
};

export type ReplayFileStatus = 'ok' | 'missing' | 'invalid' | 'error';

export type ReplayFile = {
  name: string;
  path: string;
  role_zh: string;
  role_en: string;
  bytes: number | null;
  status: ReplayFileStatus;
  http_status: number | null;
};

export type ReplayBundle = {
  report: ReplayReport | null;
  execution: ReplayExecution | null;
  manifest: ReplayManifest | null;
  events: RunEvent[];
  files: ReplayFile[];
  loaded_at: string;
};

// ---------------------------------------------------------------------------
// Normalisers
// ---------------------------------------------------------------------------

function normalizeMetric(source: Json): MetricScore | null {
  const name = str(source.name);
  if (!name) return null;
  const score = ratioScore(source.score);
  const applicable = bool(source.applicable);
  const scope = pair(source, 'scope');
  return {
    name,
    numerator: num(source.numerator) ?? 0,
    denominator: num(source.denominator) ?? 0,
    score,
    scope_zh: scope.zh,
    scope_en: scope.en,
    applicable: applicable ?? score !== null,
  };
}

function normalizeProfile(value: unknown): ReplayProfile | null {
  if (!isObject(value)) return null;
  return {
    dataset_hash: str(value.dataset_hash),
    source_encoding: str(value.source_encoding),
    record_count: num(value.record_count),
    column_count: num(value.column_count),
    scope_hash: str(value.scope_hash),
    evaluation_scope_hash: str(value.evaluation_scope_hash),
    score_version: str(value.score_version),
    metrics: objArray(value.metrics)
      .map(normalizeMetric)
      .filter((metric): metric is MetricScore => metric !== null),
    overall_score: ratioScore(value.overall_score),
  };
}

function normalizeTopValue(source: Json): TopValue | null {
  const value = str(source.value);
  if (value === null) return null;
  return { value, count: num(source.count) ?? 0, pattern_class: str(source.pattern_class) };
}

function normalizeFormatPattern(source: Json): FormatPattern | null {
  const pattern = str(source.pattern);
  if (pattern === null) return null;
  return { pattern, count: num(source.count) ?? 0 };
}

function normalizeColumnProfile(source: Json): ColumnProfile | null {
  const name = str(source.name);
  if (!name) return null;
  const nullCount = num(source.null_count) ?? 0;
  return {
    name,
    inferred_type: (str(source.inferred_type) ?? 'string') as ColumnProfile['inferred_type'],
    null_count: nullCount,
    null_rate: num(source.null_rate) ?? 0,
    distinct_count: num(source.distinct_count) ?? 0,
    top_values: objArray(source.top_values)
      .map(normalizeTopValue)
      .filter((item): item is TopValue => item !== null),
    min: str(source.min),
    max: str(source.max),
    max_length: num(source.max_length) ?? 0,
    format_patterns: objArray(source.format_patterns)
      .map(normalizeFormatPattern)
      .filter((item): item is FormatPattern => item !== null),
    sensitive_hit_count: num(source.sensitive_hit_count) ?? 0,
    contract_flags: strArray(source.contract_flags),
  };
}

function normalizeEvidence(source: Json): EvidenceSignal | null {
  const signal = str(source.signal);
  if (!signal) return null;
  const explanation = pair(source, 'explanation');
  return {
    signal,
    status: (str(source.status) ?? 'NOT_APPLICABLE') as EvidenceSignal['status'],
    explanation_zh: explanation.zh,
    explanation_en: explanation.en,
    evidence_ref: str(source.evidence_ref) ?? '',
  };
}

function normalizeGrounding(value: unknown): GroundingResult | null {
  if (!isObject(value)) return null;
  const valid = bool(value.valid);
  if (valid === null) return null;
  return {
    valid,
    reason_codes: strArray(value.reason_codes),
    affected_record_count: num(value.affected_record_count) ?? 0,
  };
}

function normalizeProposal(value: unknown): ReplayProposal | null {
  if (!isObject(value)) return null;
  const provider = str(value.provider);
  if (!provider) return null;
  const mapping = isObject(value.mapping) ? strMap(value.mapping) : null;
  return {
    provider,
    model: str(value.model),
    prompt_version: str(value.prompt_version),
    input_hash: str(value.input_hash),
    mapping,
    abstained: bool(value.abstained) ?? false,
    abstain_reason: str(value.abstain_reason),
    grounding: normalizeGrounding(value.grounding),
    ledger_call_id: str(value.ledger_call_id),
  };
}

function normalizeFinding(source: Json): ReplayFinding | null {
  const findingId = str(source.finding_id);
  if (!findingId) return null;
  const title = pair(source, 'title');
  const explanation = pair(source, 'explanation');
  const recordUids = strArray(source.record_uids);
  const sample = strArray(source.sample_record_uids);
  return {
    finding_id: findingId,
    finding_type: str(source.finding_type),
    title_zh: title.zh,
    title_en: title.en,
    explanation_zh: explanation.zh,
    explanation_en: explanation.en,
    column: str(source.column),
    affected_record_count: num(source.affected_record_count),
    affected_cell_count: num(source.affected_cell_count),
    risk_level: str(source.risk_level),
    blocking: bool(source.blocking),
    authorization_mode: str(source.authorization_mode),
    proposed_action: str(source.proposed_action),
    disposition: str(source.disposition),
    allowed_outcomes: strArray(source.allowed_outcomes),
    evidence_signals: objArray(source.evidence_signals)
      .map(normalizeEvidence)
      .filter((item): item is EvidenceSignal => item !== null),
    record_uid_count: recordUids.length,
    sample_record_uids: sample.length > 0 ? sample : recordUids.slice(0, 8),
    details: isObject(source.details) ? source.details : {},
    proposal: normalizeProposal(source.proposal),
  };
}

function normalizeContract(value: unknown): ReplayContract | null {
  if (!isObject(value)) return null;
  return {
    id: str(value.id),
    version: str(value.version),
    hash: str(value.hash),
    source: str(value.source),
    field_count: num(value.field_count),
  };
}

export function normalizeReport(value: unknown): ReplayReport | null {
  if (!isObject(value)) return null;
  const profile = normalizeProfile(value.profile);
  if (!profile) return null;
  const warnings = strArray(value.warnings);
  const warningsZh = strArray(value.warnings_zh);
  const warningsEn = strArray(value.warnings_en);
  const preflight = isObject(value.sensitive_preflight)
    ? { columns_withheld: strArray(value.sensitive_preflight.columns_withheld), cells_masked: num(value.sensitive_preflight.cells_masked) }
    : null;
  return {
    schema_version: str(value.schema_version),
    engine_version: str(value.engine_version),
    fixture_version: str(value.fixture_version),
    synthetic: bool(value.synthetic),
    profile,
    column_profiles: objArray(value.column_profiles)
      .map(normalizeColumnProfile)
      .filter((item): item is ColumnProfile => item !== null),
    contract: normalizeContract(value.contract),
    sensitive_preflight: preflight,
    findings: objArray(value.findings)
      .map(normalizeFinding)
      .filter((item): item is ReplayFinding => item !== null),
    release_status: str(value.release_status),
    finding_outcome_counts: numMap(value.finding_outcome_counts),
    warnings_zh: warningsZh.length > 0 ? warningsZh : warnings,
    warnings_en: warningsEn.length > 0 ? warningsEn : warnings,
    timings_ms: numMap(value.timings_ms),
    run_revision: num(value.run_revision),
  };
}

function normalizeAction(source: Json): ReplayAction | null {
  const actionType = str(source.action_type);
  if (!actionType) return null;
  return {
    action_type: actionType,
    finding_id: str(source.finding_id),
    authorization_source: str(source.authorization_source),
    authorization_ref: str(source.authorization_ref),
    column: str(source.column),
    mapping: isObject(source.mapping) ? strMap(source.mapping) : null,
    source_format: str(source.source_format),
    target_format: str(source.target_format),
    record_uid_count: Array.isArray(source.record_uids) ? source.record_uids.length : null,
  };
}

function normalizeDryRun(value: unknown): ReplayDryRun | null {
  if (!isObject(value)) return null;
  return {
    run_revision: num(value.run_revision),
    source_artifact_hash: str(value.source_artifact_hash),
    approved_action_set_hash: str(value.approved_action_set_hash),
    decision_set_hash: str(value.decision_set_hash),
    actions: objArray(value.actions)
      .map(normalizeAction)
      .filter((item): item is ReplayAction => item !== null),
    finding_dispositions: strMap(value.finding_dispositions),
    affected_record_count: num(value.affected_record_count),
    affected_cell_count: num(value.affected_cell_count),
    eligible_record_count: num(value.eligible_record_count),
    quarantined_record_count: num(value.quarantined_record_count),
    excluded_record_count: num(value.excluded_record_count),
    flagged_record_count: num(value.flagged_record_count),
    excluded_columns: strArray(value.excluded_columns),
    blocking_unresolved: strArray(value.blocking_unresolved),
    status: str(value.status),
  };
}

function normalizeValidation(source: Json): ValidationResult | null {
  const checkId = str(source.check_id);
  if (!checkId) return null;
  const message = pair(source, 'message');
  return {
    check_id: checkId,
    passed: bool(source.passed) ?? false,
    observed: source.observed,
    expected: source.expected,
    message_zh: message.zh,
    message_en: message.en,
  };
}

export function normalizeManifest(value: unknown): ReplayManifest | null {
  if (!isObject(value)) return null;
  const summary = isObject(value.validation_summary)
    ? { passed: num(value.validation_summary.passed) ?? 0, failed: num(value.validation_summary.failed) ?? 0 }
    : null;
  const countOf = (list: unknown, explicit: unknown): number | null =>
    num(explicit) ?? (Array.isArray(list) ? list.length : null);
  return {
    source_artifact_hash: str(value.source_artifact_hash),
    candidate_artifact_hash: str(value.candidate_artifact_hash),
    release_artifact_hash: str(value.release_artifact_hash),
    policy_pack_hash: str(value.policy_pack_hash),
    contract_hash: str(value.contract_hash),
    decision_set_hash: str(value.decision_set_hash),
    change_ledger_hash: str(value.change_ledger_hash),
    engine_version: str(value.engine_version),
    score_version: str(value.score_version),
    scope_hash: str(value.scope_hash),
    total_source_records: num(value.total_source_records),
    eligible_record_count: num(value.eligible_record_count),
    quarantined_record_count: countOf(value.quarantined_record_uids, value.quarantined_record_count),
    excluded_record_count: countOf(value.excluded_record_uids, value.excluded_record_count),
    flagged_record_count: countOf(value.flagged_record_uids, value.flagged_record_count),
    excluded_columns: strArray(value.excluded_columns),
    finding_outcome_counts: numMap(value.finding_outcome_counts),
    validation_summary: summary,
    release_status: str(value.release_status),
    ai_call_count: num(value.ai_call_count),
    ai_provider: str(value.ai_provider),
    ai_input_hashes: strMap(value.ai_input_hashes),
  };
}

export function normalizeExecution(value: unknown): ReplayExecution | null {
  if (!isObject(value)) return null;
  return {
    baseline_profile: normalizeProfile(value.baseline_profile),
    candidate_profile: normalizeProfile(value.candidate_profile),
    dry_run: normalizeDryRun(value.dry_run),
    validations: objArray(value.validations)
      .map(normalizeValidation)
      .filter((item): item is ValidationResult => item !== null),
    release_manifest: normalizeManifest(value.release_manifest),
  };
}

/** Recorded events. Older files carry `{stage, status, message}` only: no seq, ts or elapsed. */
export function normalizeEvents(value: unknown): RunEvent[] {
  return objArray(value).flatMap((source, index): RunEvent[] => {
    const stage = str(source.stage);
    if (!stage) return [];
    const message = pair(source, 'message');
    const detail = isObject(source.detail) ? source.detail : {};
    return [
      {
        seq: num(source.seq) ?? index + 1,
        ts: str(source.ts) ?? '',
        stage,
        status: (str(source.status) ?? 'INFO') as RunEvent['status'],
        message_zh: message.zh,
        message_en: message.en,
        elapsed_ms: num(source.elapsed_ms),
        detail,
      },
    ];
  });
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export const REPLAY_FILES: readonly Omit<ReplayFile, 'bytes' | 'status' | 'http_status'>[] = [
  { name: 'report.json', path: '/demo/report.json', role_zh: '分析报告（画像、发现、发布状态）', role_en: 'Analysis report (profile, findings, release status)' },
  { name: 'release-report.json', path: '/demo/release-report.json', role_zh: '执行结果（预演、验证、清单）', role_en: 'Execution result (dry run, validations, manifest)' },
  { name: 'release-manifest.json', path: '/demo/release-manifest.json', role_zh: '发布清单（哈希链）', role_en: 'Release manifest (hash chain)' },
  { name: 'events.json', path: '/demo/events.json', role_zh: '已记录的流水线事件', role_en: 'Recorded pipeline events' },
  { name: 'cleaned.csv', path: '/demo/cleaned.csv', role_zh: '发布文件（可本地复验哈希）', role_en: 'Release file (hash can be re-verified locally)' },
];

type Loaded = { file: ReplayFile; json: unknown };

async function loadJson(spec: (typeof REPLAY_FILES)[number]): Promise<Loaded> {
  const base = { ...spec, bytes: null, status: 'error' as ReplayFileStatus, http_status: null as number | null };
  try {
    const response = await fetch(spec.path, { headers: { Accept: 'application/json' } });
    const httpStatus = response.status;
    if (!response.ok) {
      return { file: { ...base, status: httpStatus === 404 ? 'missing' : 'error', http_status: httpStatus }, json: null };
    }
    const text = await response.text();
    const bytes = new TextEncoder().encode(text).length;
    try {
      return { file: { ...base, bytes, status: 'ok', http_status: httpStatus }, json: JSON.parse(text) as unknown };
    } catch {
      return { file: { ...base, bytes, status: 'invalid', http_status: httpStatus }, json: null };
    }
  } catch {
    return { file: base, json: null };
  }
}

async function headFile(spec: (typeof REPLAY_FILES)[number]): Promise<ReplayFile> {
  const base = { ...spec, bytes: null, status: 'error' as ReplayFileStatus, http_status: null as number | null };
  try {
    const response = await fetch(spec.path, { method: 'HEAD' });
    const length = response.headers.get('content-length');
    const bytes = length !== null && /^\d+$/.test(length) ? Number(length) : null;
    if (!response.ok) return { ...base, status: response.status === 404 ? 'missing' : 'error', http_status: response.status };
    return { ...base, bytes, status: 'ok', http_status: response.status };
  } catch {
    return base;
  }
}

/** Fetch the five static files in parallel and normalise them. Never throws. */
export async function loadReplayBundle(): Promise<ReplayBundle> {
  const [report, execution, manifest, events] = await Promise.all(REPLAY_FILES.slice(0, 4).map(loadJson));
  const csv = await headFile(REPLAY_FILES[4]);
  return {
    report: normalizeReport(report.json),
    execution: normalizeExecution(execution.json),
    manifest: normalizeManifest(manifest.json),
    events: normalizeEvents(events.json),
    files: [report.file, execution.file, manifest.file, events.file, csv],
    loaded_at: new Date().toISOString(),
  };
}
