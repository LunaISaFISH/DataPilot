import snapshot from '@/lib/data/uci-online-retail-replay.json';

/**
 * A privacy-minimised projection of one verified, completed UCI run.
 *
 * This is deliberately imported at build time: the booth experience has no dependency on the
 * live API, while every displayed measurement remains sourced from the exported run artifact.
 */
export const boothDemo = snapshot;

export type BoothDemo = typeof boothDemo;
export type BoothFinding = BoothDemo['findings'][number];
export type BoothAction = BoothDemo['governance']['actions'][number];
export type BoothMetric = BoothDemo['quality']['baseline']['metrics'][number];

export function boothMetric(name: string) {
  const baseline = boothDemo.quality.baseline.metrics.find((item) => item.name === name);
  const candidate = boothDemo.quality.candidate.metrics.find((item) => item.name === name);
  return { baseline, candidate };
}

export function boothFinding(id: string) {
  return boothDemo.findings.find((item) => item.finding_id === id);
}
