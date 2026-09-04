'use client';

import { useEffect, useState } from 'react';

import {
  ConfirmDialog,
  DataTable,
  HashChip,
  InlineAlert,
  KeyValueList,
  PanelSection,
  Pill,
  ProvenanceMark,
  YamlEditor,
  provenanceFromRecord,
  type DataTableColumn,
} from '@/components/datapilot';
import { Button } from '@/components/ui/button';
import { ApiError, getContractDraft } from '@/lib/api';
import { formatInt } from '@/lib/format';
import { pick, useLanguage } from '@/lib/language';
import { label } from '@/lib/labels';
import type { ContractDraftResult, RejectedRule } from '@/lib/types';

import { useWorkspace } from '../workspace-context';
import { GuardRow } from '@/components/datapilot';

type Rule = Record<string, unknown>;

const RULE_META_KEYS = new Set(['field', 'name', 'column', 'evidence_refs', 'evidence', 'rationale_zh', 'rationale_en', 'rule']);

function asString(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

/** Display form for an arbitrary contract value (scalars verbatim, objects as JSON). */
function scalarText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  if (value === null || value === undefined) return '';
  return JSON.stringify(value);
}

function ruleField(rule: Rule): string {
  return asString(rule.field) ?? asString(rule.name) ?? asString(rule.column) ?? '—';
}

function ruleText(rule: Rule): string {
  const explicit = asString(rule.rule);
  if (explicit) return explicit;
  return Object.entries(rule)
    .filter(([key, value]) => !RULE_META_KEYS.has(key) && value !== null && value !== undefined && value !== false)
    .map(([key, value]) => `${key}: ${scalarText(value)}`)
    .join(' · ');
}

function ruleEvidence(rule: Rule): string[] {
  const refs = rule.evidence_refs ?? rule.evidence;
  return Array.isArray(refs) ? refs.filter((ref): ref is string => typeof ref === 'string') : [];
}

type FieldRow = { name: string; spec: Record<string, unknown> };

function fieldRows(parsed: Record<string, unknown>): FieldRow[] {
  const fields = parsed.fields;
  if (typeof fields !== 'object' || fields === null || Array.isArray(fields)) return [];
  return Object.entries(fields as Record<string, unknown>).map(([name, spec]) => ({
    name,
    spec: typeof spec === 'object' && spec !== null ? (spec as Record<string, unknown>) : {},
  }));
}

function specPills(spec: Record<string, unknown>, language: 'zh' | 'en'): { key: string; text: string; tone: 'neutral' | 'blocker' | 'ai' | 'info' }[] {
  const pills: { key: string; text: string; tone: 'neutral' | 'blocker' | 'ai' | 'info' }[] = [];
  for (const flag of ['required', 'unique', 'sensitive', 'semantic'] as const) {
    if (spec[flag] === true) pills.push({ key: flag, text: label('contract_flag', flag, language), tone: flag === 'sensitive' ? 'blocker' : flag === 'semantic' ? 'ai' : 'neutral' });
  }
  if (typeof spec.type === 'string') pills.push({ key: 'type', text: `type: ${spec.type}`, tone: 'neutral' });
  if (typeof spec.format === 'string') pills.push({ key: 'format', text: `format: ${spec.format}`, tone: 'neutral' });
  if (Array.isArray(spec.accept_formats)) pills.push({ key: 'accept', text: `accept_formats: ${spec.accept_formats.length}`, tone: 'neutral' });
  if (Array.isArray(spec.allowed)) pills.push({ key: 'allowed', text: `${label('contract_flag', 'allowed', language)}: ${spec.allowed.length}`, tone: 'info' });
  if (typeof spec.canonical === 'object' && spec.canonical !== null) {
    pills.push({ key: 'canonical', text: `${label('contract_flag', 'canonical', language)}: ${Object.keys(spec.canonical as object).length}`, tone: 'info' });
  }
  if (typeof spec.consistent_with === 'object' && spec.consistent_with !== null) {
    const column = (spec.consistent_with as { column?: unknown }).column;
    pills.push({ key: 'consistent', text: `consistent_with: ${typeof column === 'string' ? column : '?'}`, tone: 'info' });
  }
  for (const bound of ['min', 'max', 'max_length', 'pattern'] as const) {
    if (spec[bound] !== undefined && spec[bound] !== null) pills.push({ key: bound, text: `${bound}: ${scalarText(spec[bound])}`, tone: 'neutral' });
  }
  return pills;
}

const DRAFT_POLL_MS = 2000;

export function ContractTab() {
  const { t, language } = useLanguage();
  const { run, runId, busy, putContract, draftContract, setActiveTab } = useWorkspace();
  const [draft, setDraft] = useState<ContractDraftResult | null>(null);
  const [draftError, setDraftError] = useState<ApiError | null>(null);
  const [draftYaml, setDraftYaml] = useState<string | null>(null);
  const [replacing, setReplacing] = useState(false);
  const [replaceYaml, setReplaceYaml] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<ApiError | null>(null);
  const [confirm, setConfirm] = useState<{ yaml: string; mode: 'draft' | 'replace' } | null>(null);
  const [fileNote, setFileNote] = useState<string | null>(null);

  const contract = run?.contract ?? null;
  const contractInfo = run?.report?.contract ?? null;
  const hasContract = contract !== null && contractInfo?.source !== 'baseline';
  const draftPending = draft?.status === 'pending';

  // Recover an existing draft on mount, then poll every 2 s while the backend reports `pending`.
  useEffect(() => {
    if (hasContract) return;
    let cancelled = false;
    const controller = new AbortController();
    const load = async () => {
      try {
        const result = await getContractDraft(runId, controller.signal);
        if (cancelled) return;
        setDraft(result);
        setDraftError(null);
      } catch (reason) {
        if (cancelled || (reason instanceof DOMException && reason.name === 'AbortError')) return;
        if (reason instanceof ApiError && reason.status !== 404) setDraftError(reason);
      }
    };
    void load();
    const timer = draftPending ? setInterval(() => void load(), DRAFT_POLL_MS) : null;
    return () => {
      cancelled = true;
      controller.abort();
      if (timer) clearInterval(timer);
    };
  }, [runId, hasContract, draftPending]);

  if (!run) return null;

  const startDraft = async () => {
    setSubmitError(null);
    try {
      const started = await draftContract();
      setDraft({ status: started.status, draft_yaml: null, accepted_rules: [], rejected_rules: [], ledger_call_id: null, error: null });
      setDraftYaml(null);
    } catch (reason) {
      if (reason instanceof ApiError) setSubmitError(reason);
    }
  };

  const submitContract = async () => {
    if (!confirm) return;
    setSubmitError(null);
    try {
      await putContract(confirm.yaml);
      setConfirm(null);
      setReplacing(false);
      setReplaceYaml(null);
      setActiveTab('profile');
    } catch (reason) {
      setConfirm(null);
      if (reason instanceof ApiError) setSubmitError(reason);
    }
  };

  const readYamlFile = async (file: File | undefined, target: 'draft' | 'replace') => {
    if (!file) return;
    const text = await file.text();
    if (target === 'draft') setDraftYaml(text);
    else setReplaceYaml(text);
    setFileNote(`${file.name} · ${formatInt(file.size)} B`);
  };

  const acceptedColumns: DataTableColumn<Rule>[] = [
    { key: 'field', header: t('Field', '字段'), render: (row) => <span className="mono">{ruleField(row)}</span> },
    { key: 'rule', header: t('Rule', '规则'), render: (row) => <span className="mono text-xs break-all">{ruleText(row)}</span> },
    {
      key: 'evidence',
      header: t('Evidence', '证据'),
      render: (row) => {
        const refs = ruleEvidence(row);
        return refs.length === 0 ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          <span className="inline-flex flex-wrap gap-1">
            {refs.map((ref) => (
              <Pill key={ref} variant="neutral" className="mono font-normal">
                {ref}
              </Pill>
            ))}
          </span>
        );
      },
    },
    {
      key: 'rationale',
      header: t('Rationale', '理由'),
      render: (row) => pick(language, asString(row.rationale_zh), asString(row.rationale_en)) || <span className="text-muted-foreground">—</span>,
    },
  ];

  const rejectedColumns: DataTableColumn<RejectedRule>[] = [
    { key: 'field', header: t('Field', '字段'), render: (row) => <span className="mono">{row.field}</span> },
    { key: 'rule', header: t('Rule', '规则'), render: (row) => <span className="mono text-xs break-all">{row.rule}</span> },
    {
      key: 'reason_code',
      header: t('Reason code', '拦截原因'),
      render: (row) => (
        <Pill variant="blocker" title={row.reason_code}>
          <span className="mono">{row.reason_code}</span> · {label('grounding_reason', row.reason_code, language)}
        </Pill>
      ),
    },
    { key: 'detail', header: t('Detail', '说明'), render: (row) => pick(language, row.detail_zh, row.detail_en) },
  ];

  const fieldColumns: DataTableColumn<FieldRow>[] = [
    { key: 'name', header: t('Field', '字段'), render: (row) => <span className="mono">{row.name}</span> },
    {
      key: 'spec',
      header: t('Constraints', '约束'),
      render: (row) => {
        const pills = specPills(row.spec, language);
        return pills.length === 0 ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          <span className="inline-flex flex-wrap gap-1">
            {pills.map((pill) => (
              <Pill key={pill.key} variant={pill.tone} className="mono font-normal">
                {pill.text}
              </Pill>
            ))}
          </span>
        );
      },
    },
  ];

  const confirmDialog = (
    <ConfirmDialog
      open={confirm !== null}
      onOpenChange={(open) => (open ? undefined : setConfirm(null))}
      title={confirm?.mode === 'replace' ? t('Replace contract and re-analyse', '更换发布规则并重新分析') : t('Confirm contract and re-analyse', '确认发布规则并重新分析')}
      description={t(
        'This starts a new analysis revision and clears existing decisions.',
        '系统会使用新规则重新分析，并清空之前保存的处理选择。',
      )}
      confirmLabel={t('Submit', '提交')}
      pending={busy.putContract}
      onConfirm={submitContract}
    >
      <KeyValueList
        items={[
          { key: 'rev', label: t('Current revision', '分析版本'), value: `r${run.run_revision} → r${run.run_revision + 1}`, mono: true },
          { key: 'decisions', label: t('Decisions cleared', '将清空的处理选择'), value: formatInt(Object.keys(run.decisions).length), mono: true },
          { key: 'bytes', label: t('YAML size', 'YAML 大小'), value: confirm ? `${formatInt(new TextEncoder().encode(confirm.yaml).length)} B` : '—', mono: true },
        ]}
      />
    </ConfirmDialog>
  );

  if (!hasContract) {
    const ready = draft?.status === 'ready';
    const yamlValue = draftYaml ?? draft?.draft_yaml ?? '';
    return (
      <div className="flex flex-col gap-3">
        <InlineAlert variant="info" title={t('Observational mode', '当前为快速扫描')}>
          {t(
            'No Data Contract is set. Without one the engine only observes: no required fields, vocabularies or business keys, so SEM/CAT/AMB/MISS/VAL detectors do not run and the release status stays NOT_EVALUATED. Let the AI draft a contract from the redacted profile, review every rule (rejected rules are shown with the grounding reason), edit the YAML, then confirm to re-analyse.',
            '尚未设置发布规则，因此系统只能展示基础质量问题，不能判断数据是否适合交付。你可以让 AI 根据已脱敏的字段概览起草规则，检查后再确认；AI 建议中证据不足的部分会被自动拦下。',
          )}
        </InlineAlert>

        {submitError ? <GuardRow error={submitError} /> : null}
        {draftError ? <GuardRow error={draftError} /> : null}

        <PanelSection
          id="contract-draft"
          title={t('AI contract draft', '让 AI 起草发布规则')}
          description={
            draft
              ? draft.status === 'pending'
                ? t('Drafting in progress.', 'AI 正在根据字段概览起草规则。')
                : draft.status === 'failed'
                  ? t('Drafting failed; the deterministic engine produced nothing to confirm.', '起草失败；没有可确认的内容。')
                  : t('Draft returned. Accepted rules passed grounding; rejected rules are listed with their reason codes.', '草案已经生成。通过证据校验的规则可以继续使用，被拦下的规则会说明原因。')
              : t('No draft yet. The model only sees redacted column profiles and observed patterns; never rows.', 'AI 只会看到脱敏后的字段概览和汇总特征，不会看到原始记录。')
          }
          actions={
            <Button size="sm" onClick={() => void startDraft()} disabled={busy.draftContract || draftPending || !run.report}>
              {busy.draftContract ? t('Requesting', '正在起草') : draft ? t('Draft again', '重新起草') : t('Let AI draft a contract', '让 AI 起草规则')}
            </Button>
          }
        >
          {draft?.status === 'failed' ? (
            <InlineAlert variant="warning" title={t('Draft failed', '起草失败')}>
              <span className="mono">{draft.error ?? '—'}</span>
            </InlineAlert>
          ) : null}
          {draft?.status === 'pending' ? (
            <p className="text-xs text-muted-foreground">
              <span className="mono">GET /v1/runs/{runId}/contract/draft</span> · {t('status', '状态')} <span className="mono">pending</span>
            </p>
          ) : null}
          {ready ? (
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                {draft.ledger_call_id ? (
                  <span>
                    {t('Ledger call', '调用记录')} <span className="mono">{draft.ledger_call_id}</span>
                  </span>
                ) : null}
                <span>
                  {t('Accepted', '已接受')} <span className="mono">{formatInt(draft.accepted_rules.length)}</span> · {t('Rejected', '已拦截')}{' '}
                  <span className="mono">{formatInt(draft.rejected_rules.length)}</span>
                </span>
              </div>
              <DataTable columns={acceptedColumns} rows={draft.accepted_rules} rowKey={(row, index) => `${ruleField(row)}-${index}`} maxHeight={280} emptyTitle={t('No accepted rules', '没有被接受的规则')} caption={t('Accepted rules', '已接受的规则')} />
              <PanelSection
                id="contract-rejected"
                title={t('Rules stopped by grounding', '未通过证据校验的规则')}
                description={t('Each rejected rule names the check that stopped it; nothing here reaches the contract.', '每条规则都会注明被拦下的原因，也不会进入最终发布规则。')}
                flush
              >
                <DataTable columns={rejectedColumns} rows={draft.rejected_rules} rowKey={(row, index) => `${row.field}-${row.rule}-${index}`} maxHeight={240} emptyTitle={t('Nothing was rejected', '没有规则被拦下')} />
              </PanelSection>
            </div>
          ) : null}
        </PanelSection>

        {ready || draftYaml !== null ? (
          <PanelSection
            id="contract-yaml"
            title={t('Contract YAML', '发布规则 YAML')}
            description={t('Edit before confirming; the confirmed YAML becomes the run contract with source "drafted".', '确认前可以修改；确认后系统会用这份规则重新分析数据。')}
            actions={
              <>
                <label className="inline-flex h-7 cursor-pointer items-center rounded-md border border-border bg-card px-2 text-xs hover:bg-muted">
                  {t('Load YAML file', '载入 YAML 文件')}
                  <input type="file" accept=".yaml,.yml,text/yaml" className="sr-only" onChange={(event) => void readYamlFile(event.target.files?.[0], 'draft')} />
                </label>
                <Button size="sm" disabled={!yamlValue.trim() || busy.putContract} onClick={() => setConfirm({ yaml: yamlValue, mode: 'draft' })}>
                  {t('Confirm contract and re-analyse', '确认规则并重新分析')}
                </Button>
              </>
            }
          >
            {fileNote ? <p className="mb-2 text-[11px] text-muted-foreground mono">{fileNote}</p> : null}
            <YamlEditor value={yamlValue} onChange={setDraftYaml} minRows={16} maxHeight={560} />
          </PanelSection>
        ) : (
          <PanelSection
            id="contract-upload"
            title={t('Or supply a contract YAML', '或直接提供发布规则 YAML')}
            description={t('Paste or load a v1/v2 contract; the server validates it and re-analyses.', '粘贴或载入规则文件；系统校验通过后会重新分析。')}
            actions={
              <label className="inline-flex h-7 cursor-pointer items-center rounded-md border border-border bg-card px-2 text-xs hover:bg-muted">
                {t('Load YAML file', '载入 YAML 文件')}
                <input type="file" accept=".yaml,.yml,text/yaml" className="sr-only" onChange={(event) => void readYamlFile(event.target.files?.[0], 'draft')} />
              </label>
            }
          >
            <YamlEditor value={draftYaml ?? ''} onChange={setDraftYaml} minRows={8} />
          </PanelSection>
        )}
        {confirmDialog}
      </div>
    );
  }

  // Contract present.
  const parsed = contract.parsed;
  const rows = fieldRows(parsed);
  const ambiguity = typeof parsed.ambiguity_registry === 'object' && parsed.ambiguity_registry !== null ? Object.entries(parsed.ambiguity_registry as Record<string, unknown>) : [];
  const auto = typeof parsed.auto_authorization === 'object' && parsed.auto_authorization !== null ? Object.entries(parsed.auto_authorization as Record<string, unknown>) : [];
  const businessKey = Array.isArray(parsed.business_key) ? parsed.business_key.map(String) : [];
  return (
    <div className="flex flex-col gap-3">
      {submitError ? <GuardRow error={submitError} /> : null}
      <PanelSection
        id="contract-summary"
        title={
          <span className="inline-flex flex-wrap items-center gap-2">
            {asString(parsed.id) ?? contractInfo?.id ?? t('Contract', '发布规则')}
            <span className="mono text-xs text-muted-foreground">@{asString(parsed.version) ?? contractInfo?.version ?? '—'}</span>
            <Pill variant={contract.source === 'drafted' ? 'ai' : 'policy'}>{label('contract_source', contract.source, language)}</Pill>
          </span>
        }
        description={pick(language, asString(parsed.title_zh), asString(parsed.title_en)) || undefined}
        actions={
          <>
            <HashChip value={contract.hash} label={t('contract', '规则')} length={16} />
            <Button size="sm" variant="outline" onClick={() => setReplacing((value) => !value)} disabled={run.lifecycle === 'APPLIED'}>
              {replacing ? t('Cancel replace', '取消更换') : t('Replace contract', '更换规则')}
            </Button>
          </>
        }
      >
        <KeyValueList
          columns={2}
          items={[
            { key: 'fields', label: t('Declared fields', '声明字段'), value: formatInt(rows.length), mono: true },
            { key: 'bk', label: t('Business key', '业务键'), value: businessKey.length ? businessKey.join(', ') : '—', mono: true },
            {
              key: 'amb',
              label: t('Ambiguity registry', '多义词清单'),
              value: ambiguity.length ? ambiguity.map(([column, tokens]) => `${column}: ${Array.isArray(tokens) ? tokens.length : 0}`).join(' · ') : '—',
              mono: true,
            },
            {
              key: 'auto',
              label: t('Auto authorization', '允许自动处理'),
              value: auto.length ? auto.filter(([, enabled]) => enabled === true).map(([name]) => name).join(', ') || t('none', '无') : '—',
              mono: true,
            },
          ]}
        />
      </PanelSection>

      <PanelSection id="contract-rules" title={t('Rule summary', '规则摘要')} flush>
        <DataTable columns={fieldColumns} rows={rows} rowKey={(row) => row.name} maxHeight={360} emptyTitle={t('No fields declared', '未声明字段')} />
      </PanelSection>

      {replacing ? (
        <PanelSection
          id="contract-replace"
          title={t('Replace contract', '更换发布规则')}
          description={t('Submitting re-analyses the same source: revision +1, decisions cleared, dry run invalidated.', '提交后会重新分析同一份源文件，之前的处理选择和执行预览将被清空。')}
          actions={
            <>
              <label className="inline-flex h-7 cursor-pointer items-center rounded-md border border-border bg-card px-2 text-xs hover:bg-muted">
                {t('Load YAML file', '载入 YAML 文件')}
                <input type="file" accept=".yaml,.yml,text/yaml" className="sr-only" onChange={(event) => void readYamlFile(event.target.files?.[0], 'replace')} />
              </label>
              <Button size="sm" disabled={busy.putContract || !(replaceYaml ?? contract.yaml).trim()} onClick={() => setConfirm({ yaml: replaceYaml ?? contract.yaml, mode: 'replace' })}>
                {t('Submit and re-analyse', '提交并重新分析')}
              </Button>
            </>
          }
        >
          {fileNote ? <p className="mb-2 text-[11px] text-muted-foreground mono">{fileNote}</p> : null}
          <YamlEditor value={replaceYaml ?? contract.yaml} onChange={setReplaceYaml} minRows={16} maxHeight={560} />
        </PanelSection>
      ) : (
        <PanelSection id="contract-view" title={t('Contract YAML', '发布规则 YAML')} description={t('Read-only view of the stored contract.', '查看当前生效的规则文件。')}>
          <YamlEditor value={contract.yaml} readOnly minRows={12} maxHeight={560} />
        </PanelSection>
      )}
      <LedgerNote ledgerCallId={null} />
      {confirmDialog}
    </div>
  );
}

/** Shows the contract-draft ledger record (provenance) when the current contract was drafted. */
function LedgerNote({ ledgerCallId }: { ledgerCallId: string | null }) {
  const { t } = useLanguage();
  const { ledger, run } = useWorkspace();
  if (run?.contract?.source !== 'drafted') return null;
  const record = ledger.find((entry) => entry.task === 'contract_draft' && (ledgerCallId === null || entry.call_id === ledgerCallId));
  if (!record) return null;
  return (
    <p className="inline-flex items-center gap-2 text-xs text-muted-foreground">
      <ProvenanceMark provenance={provenanceFromRecord(record)} showModel />
      {t('This contract was drafted by the model and confirmed by a human.', '这份发布规则由 AI 起草，并经过人工确认。')}
    </p>
  );
}
