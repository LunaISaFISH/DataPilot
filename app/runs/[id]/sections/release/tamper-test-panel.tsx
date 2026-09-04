'use client';

import { useState } from 'react';

import { InlineAlert, PanelSection, Pill, ReleaseStatusPill } from '@/components/datapilot';
import { Button } from '@/components/ui/button';
import { ApiError } from '@/lib/api';
import { useLanguage } from '@/lib/language';
import type { TamperTestResult } from '@/lib/types';

import { useWorkspace } from '../../workspace-context';
import { GuardRow } from '@/components/datapilot';
import { FullHash, HashVerdict } from './hash-equality';
import { ValidationTable } from './validation-table';

const HIGHLIGHT = ['SOURCE_IMMUTABLE'] as const;

/**
 * 篡改测试: `POST /tamper-test` re-runs execute in memory against a copy of the source with one
 * byte flipped. Nothing is written; the real run is untouched. Labelled as a demonstration.
 */
export function TamperTestPanel() {
  const { t } = useLanguage();
  const { run, busy, tamperTest } = useWorkspace();
  const [result, setResult] = useState<TamperTestResult | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  const start = async () => {
    setError(null);
    try {
      setResult(await tamperTest());
    } catch (reason) {
      if (reason instanceof ApiError) setError(reason);
    }
  };

  const realSource = run?.dry_run?.source_artifact_hash ?? run?.execution?.release_manifest.source_artifact_hash ?? null;
  const immutable = result?.validations.find((check) => check.check_id === 'SOURCE_IMMUTABLE') ?? null;
  const observed = immutable && typeof immutable.observed === 'string' ? immutable.observed : null;
  const expected = immutable && typeof immutable.expected === 'string' ? immutable.expected : realSource;

  return (
    <PanelSection
      id="release-tamper"
      title={
        <span className="inline-flex flex-wrap items-center gap-2">
          {t('Tamper test', '篡改测试')}
          <Pill variant="review">{t('Demo · in memory · nothing written', '演示 · 内存中进行 · 不落盘')}</Pill>
        </span>
      }
      description={t(
        'POST /v1/runs/{id}/tamper-test flips one byte of a copy of the source and re-runs execute in memory. SOURCE_IMMUTABLE must fail and the release must be BLOCKED.',
        'POST /v1/runs/{id}/tamper-test 对源文件副本翻转一个字节并在内存中重跑执行。SOURCE_IMMUTABLE 必须失败，发布必须被阻断。',
      )}
      actions={
        <Button size="sm" variant="outline" onClick={() => void start()} disabled={busy.tamperTest || !run?.dry_run}>
          {busy.tamperTest ? t('Running in memory', '内存中运行') : result ? t('Run again', '再次运行') : t('Run tamper test', '运行篡改测试')}
        </Button>
      }
      flush={result !== null && !error}
    >
      {error ? <GuardRow error={error} onRetry={() => void start()} /> : null}
      {!run?.dry_run && !error ? <p className="text-xs text-muted-foreground">{t('Requires a dry run: the test executes the approved action set against the tampered copy.', '需要先有预演：测试会对篡改副本执行已批准的动作集。')}</p> : null}
      {result ? (
        <div className="flex flex-col">
          <div className="flex flex-wrap items-center gap-3 border-b border-border px-3 py-2 text-xs">
            <span className="flex items-center gap-1.5">
              <span className="text-muted-foreground">{t('Release status', '发布状态')}</span>
              <ReleaseStatusPill value={result.release_manifest.release_status} />
            </span>
            <span className="flex items-center gap-1.5">
              <span className="text-muted-foreground">SOURCE_IMMUTABLE</span>
              {immutable ? (
                <span className={immutable.passed ? 'mono font-semibold text-policy' : 'mono font-semibold text-blocker'}>{immutable.passed ? `✓ ${t('Pass', '通过')}` : `✗ ${t('Fail', '未通过')}`}</span>
              ) : (
                <span className="mono text-muted-foreground">—</span>
              )}
            </span>
            <span className="flex items-center gap-1.5">
              <span className="text-muted-foreground">written</span>
              <span className="mono">{String(result.written)}</span>
            </span>
            <HashVerdict left={observed} right={expected} />
          </div>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 border-b border-border px-3 py-2 text-[11px]">
            <dt className="text-muted-foreground">{t('Tampered copy (observed)', '篡改副本（观测）')}</dt>
            <dd>
              <FullHash value={observed} />
            </dd>
            <dt className="text-muted-foreground">{t('Stored source (expected)', '已存源文件（期望）')}</dt>
            <dd>
              <FullHash value={expected} />
            </dd>
          </dl>
          <ValidationTable validations={result.validations} highlight={HIGHLIGHT} maxHeight={320} ariaLabel={t('Tamper test validations', '篡改测试验证')} />
          <div className="px-3 py-2">
            <InlineAlert variant="info">{t('No artifact was written; the real run is unaffected.', '未写入任何工件；真实运行未受影响。')}</InlineAlert>
          </div>
        </div>
      ) : null}
    </PanelSection>
  );
}
