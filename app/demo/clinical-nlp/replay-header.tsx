'use client';

import { HashChip, Pill, ReleaseStatusPill } from '@/components/datapilot';
import { formatInt, formatScore } from '@/lib/format';
import { useLanguage } from '@/lib/language';
import { label } from '@/lib/labels';

import type { ReplayBundle } from './replay-data';
import { ReplayBadge, replayAiCounters } from './replay-ui';

function Group({ children, title }: { children: React.ReactNode; title?: string }) {
  return (
    <div className="flex items-center gap-2 whitespace-nowrap" title={title}>
      {children}
    </div>
  );
}

function Count({ k, v }: { k: string; v: string }) {
  return (
    <span className="inline-flex items-baseline gap-1">
      <span className="text-[11px] text-muted-foreground">{k}</span>
      <span className="mono text-xs">{v}</span>
    </span>
  );
}

/** Same strip as the run console, with the persistent 离线回放 badge and the recorded-run sentence. */
export function ReplayHeader({ bundle }: { bundle: ReplayBundle | null }) {
  const { t, language } = useLanguage();
  const report = bundle?.report ?? null;
  const manifest = bundle?.manifest ?? bundle?.execution?.release_manifest ?? null;
  const findings = report?.findings ?? [];
  const blocking = findings.filter((finding) => finding.blocking === true).length;
  const ai = replayAiCounters(findings);
  const contract = report?.contract ?? null;
  const observational = contract === null || contract.source === 'baseline';
  const sourceName = report?.fixture_version ? `clinical_nlp · ${report.fixture_version}` : 'clinical_nlp';

  return (
    <header className="flex flex-col border-b border-border bg-card">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-3 py-1.5">
        <Group>
          <ReplayBadge />
          <span className="max-w-[28ch] truncate text-[13px] font-semibold" title={sourceName}>
            {sourceName}
          </span>
          <Pill variant="neutral" className="mono">
            r{report?.run_revision !== null && report?.run_revision !== undefined ? formatInt(report.run_revision) : '—'}
          </Pill>
          {report?.engine_version ? (
            <Pill variant="neutral" className="mono" title={t('Engine version that produced the artifacts', '生成工件的引擎版本')}>
              {t('engine', '引擎')} {report.engine_version}
            </Pill>
          ) : null}
        </Group>

        <Group>
          {report?.profile.source_encoding ? (
            <Pill variant="neutral" className="mono" title={t('Source encoding', '源文件编码')}>
              {report.profile.source_encoding}
            </Pill>
          ) : null}
          {report ? (
            observational ? (
              <Pill variant="neutral" title={t('The artifact carries no contract block', '工件未包含契约信息')}>
                {contract ? t('Observational', '仅观测') : t('Contract unavailable', '契约信息不可用')}
              </Pill>
            ) : (
              <Pill variant="policy" title={contract ? `${contract.id ?? ''}@${contract.version ?? ''} · ${contract.hash ?? ''}` : undefined}>
                {t('Contract', '契约')} · {label('contract_source', contract?.source, language)}
                {contract?.id ? <span className="mono font-normal">{` ${contract.id}@${contract.version ?? '—'}`}</span> : null}
              </Pill>
            )
          ) : null}
          {report?.profile.dataset_hash ? <HashChip value={report.profile.dataset_hash} label={t('dataset', '数据集')} /> : null}
        </Group>

        <Group title={t('Quality score is not release status: a high score can still be blocked.', '质量分不等于发布状态：高分仍可能被阻断。')}>
          <span className="text-[11px] text-muted-foreground">{t('Score', '质量分')}</span>
          <span className="mono text-2xl font-semibold leading-none tracking-tight">
            {report ? formatScore(report.profile.overall_score) : '—'}
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="text-[11px] text-muted-foreground">{t('at analysis', '分析时')}</span>
            <ReleaseStatusPill value={report?.release_status ?? null} />
          </span>
          {manifest?.release_status ? (
            <span className="inline-flex items-center gap-1">
              <span className="text-[11px] text-muted-foreground">{t('after apply', '执行后')}</span>
              <ReleaseStatusPill value={manifest.release_status} />
            </span>
          ) : null}
        </Group>

        <Group>
          <Count k={t('records', '记录')} v={report?.profile.record_count !== null && report?.profile.record_count !== undefined ? formatInt(report.profile.record_count) : '—'} />
          <Count k={t('columns', '字段')} v={report?.profile.column_count !== null && report?.profile.column_count !== undefined ? formatInt(report.profile.column_count) : '—'} />
          <Count
            k={t('findings', '问题')}
            v={report ? `${formatInt(findings.length)}${blocking ? ` · ${t('blocking', '阻断')} ${formatInt(blocking)}` : ''}` : '—'}
          />
        </Group>

        <Group title={t('Recorded model proposals / abstentions / grounding rejections', '已记录的模型提议 / 弃权 / 被落地校验拦截')}>
          {ai.provider ? (
            <>
              <Pill variant={ai.provider === 'anthropic' ? 'ai' : 'neutral'}>{label('provider', ai.provider, language)}</Pill>
              <Count k={t('proposed', '提议')} v={formatInt(ai.proposed)} />
              <Count k={t('abstained', '弃权')} v={formatInt(ai.abstained)} />
              <Count k={t('rejected', '被拒')} v={formatInt(ai.rejected)} />
            </>
          ) : (
            <Pill variant="neutral">{t('No model proposals recorded', '无模型提议记录')}</Pill>
          )}
        </Group>
      </div>
      <p className="border-t border-border px-3 py-1.5 text-xs leading-4 text-muted-foreground">
        {t(
          'This page replays a recorded engine run from the static files under /demo. Nothing here calls a model or an API; every number is read from those files.',
          '本页回放的是一次已记录的引擎运行，数据来自 /demo 下的静态文件。页面不调用模型，也不连接 API；所有数字均读取自这些文件。',
        )}
        {report?.synthetic === true ? <span> · {t('Synthetic data, not real clinical records.', '合成数据，非真实临床记录。')}</span> : null}
      </p>
    </header>
  );
}
