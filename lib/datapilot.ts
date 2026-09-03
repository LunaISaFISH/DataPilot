export type MetricScore = {
  name: string;
  numerator: number;
  denominator: number;
  score: number | null;
};

export type EvidenceSignal = {
  signal: string;
  status: 'PASS' | 'FAIL' | 'NOT_APPLICABLE';
  explanation: string;
  evidence_ref: string;
};

export type Finding = {
  finding_id: string;
  finding_type: string;
  title: string;
  column: string | null;
  affected_record_count: number;
  affected_cell_count: number;
  risk_level: 'LOW' | 'MEDIUM' | 'HIGH';
  blocking: boolean;
  authorization_mode: string;
  proposed_action: string | null;
  disposition: string;
  evidence_signals: EvidenceSignal[];
  record_uids: string[];
  details: Record<string, unknown>;
};

export type Profile = {
  dataset_hash: string;
  record_count: number;
  column_count: number;
  scope_hash: string;
  evaluation_scope_hash: string;
  score_version: string;
  metrics: MetricScore[];
  overall_score: number | null;
};

export type RunReport = {
  schema_version: '1.0';
  engine_version: string;
  fixture_version: string | null;
  synthetic: boolean;
  profile: Profile;
  findings: Finding[];
  release_status: 'NOT_EVALUATED' | 'BLOCKED' | 'CONDITIONAL_PASS' | 'PASS';
  finding_outcome_counts: Record<string, number>;
  warnings: string[];
};

export type ApprovedAction = {
  action_type: string;
  finding_id: string;
  record_uids?: string[];
  column?: string;
  authorization_source: 'POLICY' | 'HUMAN';
  authorization_ref: string;
};

export type ExecutionResult = {
  baseline_profile: Profile;
  candidate_profile: Profile;
  dry_run: {
    approved_action_set_hash: string;
    actions: ApprovedAction[];
    finding_dispositions: Record<string, string>;
    affected_record_count: number;
    affected_cell_count: number;
    eligible_record_count: number;
    quarantined_record_count: number;
    excluded_record_count: number;
    excluded_columns: string[];
    status: 'NOT_APPLIED';
  };
  validations: Array<{
    check_id: string;
    passed: boolean;
    message: string;
  }>;
  release_manifest: {
    candidate_artifact_hash: string;
    release_artifact_hash: string;
    eligible_record_count: number;
    quarantined_record_uids: string[];
    excluded_record_uids: string[];
    excluded_columns: string[];
    finding_outcome_counts: Record<string, number>;
    validation_summary: { passed: number; failed: number };
    release_status: 'CONDITIONAL_PASS' | 'PASS' | 'BLOCKED';
  };
};

export const shortHash = (value: string) => value.slice(0, 10);

export const formatLabel = (value: string) =>
  value
    .toLowerCase()
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');

